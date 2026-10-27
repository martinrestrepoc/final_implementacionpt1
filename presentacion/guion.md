

# Diapositiva 1. Contexto, reglas de negocio y restricciones
- Plataforma de carreras de medianos con apuestas en **EIA Coins ficticios**, sin compra, retiro ni canje por dinero.
- El trabajo consiste en **diseñar y justificar la arquitectura**; no exige implementarla.
- Carga normal: 500 usuarios concurrentes.
- Final: 100.000 usuarios concurrentes y un pico de 10.000 apuestas por segundo durante 30 segundos.
- Respuesta de aceptación o rechazo: menos de un segundo.
- Ninguna apuesta aceptada ni movimiento de billetera puede perderse.
- Liquidación completa: menos de 15 minutos desde el resultado oficial.
- Estadísticas: minutos de retraso permitidos. Reportes premium: hasta un día.
- Auditoría: conservación mínima de cinco años.

Funcionamiento del negocio:

- Cada carrera tiene identificador, horario, pista, distancia, participantes, estado y resultados.
- Cada apuesta registra usuario, carrera, mediano, monto, fecha e identificador de operación.
- Se permiten varias apuestas por usuario y carrera, incluso sobre participantes diferentes.
- Modelo de premios: bolsa común; comisión del 10 %; distribución del 90 % restante entre apuestas ganadoras, proporcional al monto apostado.
- Las cuotas mostradas antes del cierre son estimaciones.
- Cancelación: devolución del 100 % de lo apostado.
- Estados: `PROGRAMADA → ABIERTA → CERRADA → EN_CURSO → FINALIZADA → LIQUIDADA`.
- Cancelación permitida desde estados anteriores a `FINALIZADA`.

# Diapositiva 2. Selección del estilo arquitectónico
**Decisión:** arquitectura híbrida.

- Núcleo transaccional: aplicación modular con apuestas, billetera y liquidación.
- Servicios separados: Usuarios, Carreras, Notificaciones, Estadísticas y Auditoría.
- Motivo principal: aceptar una apuesta y descontar sus fondos deben ser una operación atómica.
- La separación de capacidades de apoyo permite despliegues, escalado y recuperación independientes.

Alternativas descartadas:

| Alternativa | Motivo |
|---|---|
| Monolito para toda la plataforma | Acopla despliegue y escalado de funciones con cargas diferentes; comparte un dominio de fallo mayor. |
| Microservicio por capacidad | Separar apuestas y billetera exige reservas, confirmaciones y compensaciones distribuidas. |
| Encolar primero y validar después | Recibir la solicitud en una cola no permite afirmar que fue aceptada; falta validar saldo, cierre y duplicados. |

El núcleo es un **monolito modular**: un despliegue con límites internos definidos. La plataforma completa es híbrida porque combina ese núcleo con servicios independientes.

# Diapositiva 3. División de servicios y responsabilidades
| Servicio | Responsabilidades y agrupación |
|---|---|
| Apuestas | Registro de apuestas, billeteras, movimientos, cálculo de premios, pagos y devoluciones. |
| Usuarios | Registro, autenticación, perfiles, roles, bloqueo y estado de cuentas. |
| Carreras | Programación, pistas, participantes, estados, resultados y correcciones. |
| Notificaciones | Correo, push, avisos internos, preferencias y registro de entregas. |
| Estadísticas | Históricos, cuotas estimadas, tendencias, reportes premium y detección de fraude. |
| Auditoría | Conservación inalterable y consulta de operaciones y decisiones administrativas. |

Justificación de agrupaciones:

- **Medianos dentro de Carreras:** relación directa con participantes e históricos; no hay una necesidad de escalado independiente que justifique otro servicio.
- **Resultados dentro de Carreras:** son parte del estado y la historia de una carrera.
- **Premios dentro de Apuestas:** requieren consultar apuestas y modificar billeteras.
- **Usuarios independiente:** aislamiento de identidad, credenciales y datos personales.
- Gateway como componente de entrada: autenticación, enrutamiento y limitación de tráfico.

Información de medianos: nombre, edad, peso, estado, carreras, victorias, derrotas y velocidad promedio.

# Diapositiva 4. Diagrama general y fronteras
Flujo principal:

`Cliente → Gateway → Servicio → Base de datos`

Flujo posterior:

`Transacción → Outbox → Kafka → Consumidores`

Distribución de trabajos:

`Productor → RabbitMQ → Workers`

- El Gateway es el punto público de entrada a las APIs.
- Servicios, bases de datos, brokers y almacenamiento quedan en red privada.
- Cada servicio es propietario de sus datos.
- Ningún servicio consulta directamente la base de otro.
- Apuestas y billetera comparten la misma frontera transaccional.
- Los workers de premios pertenecen al núcleo de Apuestas, aunque puedan ejecutarse como procesos separados.
- Las flechas síncronas indican dependencia inmediata de una respuesta.
- Las flechas asíncronas indican procesamiento posterior mediante mensajes.

La caída de un consumidor no debe deshacer una apuesta ya confirmada.

# Diapositiva 5. Flujo completo de creación de una apuesta
1. La aplicación genera una clave para la operación lógica y la conserva durante los reintentos.
2. Envía token, carrera, participante, monto y clave.
3. El Gateway verifica token, permisos y límites de tráfico.
4. Apuestas busca una operación previa con la misma combinación de usuario y clave.
5. Si ya existe, devuelve el resultado original.
6. Si es nueva, inicia una transacción y valida:
   - Usuario autorizado y no bloqueado según el estado disponible.
   - Monto positivo y formato válido.
   - Carrera abierta y dentro del plazo.
   - Mediano participante.
   - Saldo suficiente.
7. Descuenta mediante una actualización condicionada al saldo disponible.
8. Guarda apuesta, movimiento, resultado de la operación y eventos en outbox.
9. Confirma la transacción.
10. Devuelve la aceptación.
11. Publicación de eventos, avisos y actualización de estadísticas ocurren después.

Si falla una validación, no queda descuento ni apuesta aceptada.

**Precisión:** si la transacción se confirma y se pierde la respuesta, el resultado es desconocido para el cliente, no necesariamente rechazado. Se recupera consultando o reintentando con la misma clave.

# Diapositiva 6. Comunicación síncrona: apuestas y acceso
| Origen → destino | Protocolo | Información / motivo | Fallo o timeout |
|---|---|---|---|
| App → Gateway | REST/HTTPS | Solicitudes del usuario; necesita respuesta inmediata. | Reintento controlado con la misma clave en operaciones mutables. |
| Gateway → Usuarios | REST | Registro e inicio de sesión; entrega identidad y sesión. | Reintento limitado; después, informar indisponibilidad. |
| Gateway → Usuarios | REST | Obtención periódica de claves públicas para validar JWT. | Usar claves válidas almacenadas; rechazar tokens que no puedan verificarse. |
| Gateway → Apuestas | gRPC | Apostar, saldo y movimientos; requiere resultado transaccional. | Tiempo de espera acotado; recuperar resultado mediante la clave. |
| Apuestas → Carreras | gRPC excepcional | Recuperar una carrera ausente en la proyección local. | No aceptar si faltan datos necesarios para validar. |

- El JWT se verifica localmente; no se consulta Usuarios en cada apuesta.
- La proyección local contiene participantes y hora de cierre, recibidos mediante `CarreraAbierta`.
- Todas las llamadas deben tener límites de espera explícitos.
- Reintentos internos limitados para evitar multiplicar la carga.
- Circuit breaker para dejar de insistir temporalmente en dependencias fallidas.

# Diapositiva 7. Comunicación síncrona: consultas y administración
| Origen → destino | Protocolo | Información / motivo | Respuesta ante fallo |
|---|---|---|---|
| Gateway → Carreras | REST | Listados y fichas; consulta interactiva. | Copia anterior, identificada como desactualizada. |
| Carreras → Apuestas | gRPC | Total apostado para el operador. | Último valor disponible, marcado como aproximado. |
| Gateway → Estadísticas | REST | Reportes y tendencias. | Reporte anterior dentro del retraso permitido. |
| Gateway → Auditoría | REST | Reconstrucción de una carrera. | Consulta paginada, exportación posterior o indisponibilidad explícita. |
| Gateway → Usuarios/Carreras | REST por acceso administrativo privado | Roles, bloqueos, programación, cancelación y resultados. | Consultar estado antes de repetir; operaciones con clave y control de versión. |
| Notificaciones → Proveedor | HTTPS | Entrega de correo o push. | Reintentos asíncronos mediante RabbitMQ. |

- La comunicación con el proveedor es síncrona para el worker, pero está fuera de la petición de apuesta.
- Los datos aproximados sirven para información; no autorizan descuentos ni pagos.
- Las operaciones administrativas se validan por rol y quedan auditadas.

# Diapositiva 8. Eventos y comunicación asíncrona
Todos los eventos se publican en **Kafka**. Campos comunes: `eventoId`, tipo, versión de esquema, fecha, productor, identificador de entidad y datos del negocio.

| Evento | Productor | Consumidores principales | Clave | Datos específicos |
|---|---|---|---|---|
| `UsuarioRegistrado` | Usuarios | Apuestas, Notificaciones, Estadísticas | usuarioId | Usuario y datos necesarios para crear su billetera. |
| `UsuarioEstadoCambiado` | Usuarios | Apuestas, Auditoría, Notificaciones | usuarioId | Estado, motivo y responsable. |
| `CarreraProgramada` | Carreras | Notificaciones, Estadísticas, Auditoría | carreraId | Horario, pista, distancia y participantes. |
| `CarreraAbierta` | Carreras | Apuestas, Notificaciones, Estadísticas | carreraId | Cierre y participantes. |
| `CarreraCerrada` | Carreras | Apuestas, actualización de apps, Estadísticas, Auditoría | carreraId | Carrera y cierre. |
| `CarreraIniciada` | Carreras | Notificaciones, actualización de apps, Estadísticas | carreraId | Inicio efectivo. |
| `ResultadoPublicado` | Carreras | Liquidación, Notificaciones, Estadísticas, Auditoría | carreraId | Ganador, clasificación y versión. |
| `ResultadoCorregido` | Carreras | Liquidación, Auditoría, Estadísticas, Notificaciones | carreraId | Versiones, cambio, motivo y aprobadores. |
| `CarreraCancelada` | Carreras | Apuestas, Notificaciones, Auditoría, Estadísticas | carreraId | Motivo, fecha y responsable. |
| `ApuestaAceptada` | Apuestas | Estadísticas/fraude, Cuotas, Auditoría, Notificaciones | carreraId | Apuesta, usuario, mediano, monto y operación. |
| `ApuestaRechazada` | Apuestas | Fraude y Auditoría | carreraId | Intento y motivo. |
| `CuotasEstimadasActualizadas` | Proceso de cuotas | Actualización de apps y Estadísticas | carreraId | Totales y cuotas estimadas. |
| `LiquidacionCalculada` | Apuestas | Auditoría y Estadísticas | carreraId | Bolsa, comisión, factor de reparto y versión. |
| `MovimientoBilleteraRegistrado` | Apuestas | Auditoría, Estadísticas, Notificaciones | usuarioId | Tipo, monto, saldo y operación causante. |
| `LiquidacionFinalizada` | Apuestas | Carreras, Auditoría y Notificaciones | carreraId | Totales pagados y duración. |

Decisiones sobre eventos sugeridos:

- `ApuestaRealizada` se precisa como `ApuestaAceptada`.
- `PremioCalculado` se agrupa en `LiquidacionCalculada`, por carrera.
- `PremioPagado` se representa mediante un movimiento de tipo premio.
- La propuesta agrupa `CarreraFinalizada` con `ResultadoPublicado`. Si finalizar y oficializar resultados son momentos distintos, deben conservarse separados.

# Diapositiva 9. Diseño de Kafka y RabbitMQ
**Kafka**

- Productores: servicios mediante procesos que publican desde outbox.
- Topics: `usuarios.eventos`, `carreras.eventos`, `carreras.resultados`, `apuestas.aceptadas`, `apuestas.rechazadas`, `billetera.movimientos`, `cuotas.estimadas` y `premios.eventos`.
- Propuesta inicial: 24 particiones para `apuestas.aceptadas`, sujetas a medición.
- Grupos independientes para Estadísticas, Auditoría, Cuotas y Notificaciones.
- Retención operativa propuesta: una semana; archivo posterior en almacenamiento histórico.
- Replicación propuesta: tres copias, con configuración de confirmaciones y réplicas mínimas acorde con la durabilidad requerida.
- El consumidor confirma su avance después de persistir el efecto.

**Precisión:** Kafka conserva orden dentro de una partición; no garantiza orden global entre topics. Los consumidores deben usar versiones y validar transiciones.

**RabbitMQ**

| Tarea | Productor | Exchange / tipo | Routing key | Cola / consumidor |
|---|---|---|---|---|
| `LiquidarLote` | Apuestas | `liquidacion` / direct | `liquidacion.lote` | `q.liquidacion.lotes`; workers de pago. |
| `EnviarNotificacion` | Notificaciones | `notificaciones` / topic | `notif.email.*`, `notif.push.*`, `notif.inapp.*` | Una cola por canal. |
| `RecalcularEstadisticas` | Estadísticas | `estadisticas` / direct | `estadisticas.recalculo` | Workers de recálculo. |

- Colas durables, mensajes persistentes y confirmación de publicación.
- Confirmación manual del consumidor después del commit.
- Reintentos con espera y cola de errores con alerta.
- Ambos brokers pueden redeliverar; consumidores idempotentes.
- Dos tecnologías implican costo adicional de operación, seguridad y monitoreo.

# Diapositiva 10. Idempotencia y prevención de duplicados
| Operación | Identificador / restricción | Efecto |
|---|---|---|
| Crear apuesta | Usuario + clave de operación | Una apuesta por operación lógica. |
| Descontar saldo | Usuario + operación causante | Un solo débito por apuesta. |
| Pagar premio | Apuesta + versión del resultado | Un pago por versión. |
| Devolver apuesta | Apuesta + operación de devolución | Un solo reembolso. |
| Procesar lote | Carrera + versión + lote | Reanudar sin pagar otra vez. |
| Consumir evento | Consumidor + eventoId | No repetir el efecto del mensaje. |

Caso de los cuatro clics:

- Misma clave en las cuatro solicitudes.
- Una transacción efectiva.
- Un descuento de 500 EIA Coins.
- Los demás intentos recuperan el resultado original.
- La restricción de base de datos resuelve también solicitudes simultáneas.

Precisiones:

- Misma clave con contenido diferente: rechazar por conflicto.
- Una apuesta nueva, aunque coincidan carrera y monto, lleva otra clave.
- Deduplicación y cambio de negocio se guardan en la misma transacción.
- La limpieza de respuestas temporales no debe eliminar la protección persistente contra dobles movimientos.
- La caché puede acelerar; no sustituye las restricciones únicas.

# Diapositiva 11. Datos, consistencia y cálculo de premios
| Componente | Almacenamiento |
|---|---|
| Apuestas | Relacional dedicada: apuestas, saldos, movimientos, liquidaciones y outbox. |
| Usuarios | Relacional propia para identidad, perfiles y roles. |
| Carreras | Relacional propia para entidades, estados y versiones de resultados. |
| Notificaciones | Relacional pequeña para preferencias, plantillas y entregas. |
| Estadísticas | Histórico en archivos + almacén analítico para agregaciones y reportes. |
| Auditoría | Almacenamiento inalterable con retención mínima de cinco años. |

- Usuarios, Carreras y Notificaciones pueden compartir infraestructura inicialmente, con bases y credenciales separadas.
- Consistencia fuerte: saldo, movimientos, aceptación, transición local de estados y registro de pagos.
- Consistencia eventual: proyecciones, cuotas, estadísticas, notificaciones y llegada de registros a Auditoría.
- Outbox evita separar el commit del negocio del registro de su evento.
- No se necesita saga entre apuestas y billetera porque comparten transacción.
- Histórico operativo propuesto en Apuestas: 90 días; lo anterior se archiva conservando trazabilidad.

**Liquidación pari-mutuel**

- `B`: bolsa total.
- `G`: suma de montos apostados al ganador.
- Comisión: `0,10 × B`.
- Bolsa repartible: `0,90 × B`.
- Premio de una apuesta ganadora de monto `m`: `(m / G) × 0,90 × B`.
- El premio representa el total acreditado; no se devuelve además la apuesta original.
- Precisión fija o unidades enteras; evitar coma flotante.
- Política de redondeo y sobrantes explícita y auditable.
- Supuesto de la propuesta cuando `G = 0`: devolución completa sin comisión. El enunciado no define ese caso.

# Diapositiva 12. Carga masiva, cierre y prevención de doble gasto
- Pico total: 300.000 apuestas en 30 segundos.
- Preparación de capacidad antes de la carrera.
- Escalado horizontal: Gateway, instancias de Apuestas y distribución de actualizaciones a clientes.
- Base transaccional: dimensionamiento de escritura, índices adecuados, transacciones cortas y pool de conexiones.
- Lecturas informativas mediante caché y réplicas; la autorización del gasto usa el saldo transaccional.
- Cuotas mediante agregación asíncrona; evitar actualizar una sola fila de total por cada apuesta.
- SSE o WebSocket para distribuir actualizaciones y reducir consultas repetidas.
- Particionar tablas facilita mantenimiento y consultas, pero no equivale a distribuir escrituras entre servidores.
- Una clave Kafka basada solo en `carreraId` concentra una carrera popular en una partición; debe medirse y, si limita, subdividir el flujo de apuestas.

**Cierre**

- Hora fijada al abrir la carrera.
- Validación definitiva dentro de la operación, con hora actual de la base de datos.
- Al alcanzar el instante de cierre, se rechazan nuevas apuestas.
- No depender de que llegue `CarreraCerrada`.
- Las solicitudes retenidas o reintentadas después del cierre también se rechazan.

**Doble gasto**

- Débito atómico condicionado a saldo suficiente.
- Serialización de modificaciones concurrentes de la misma billetera.
- Restricción adicional que impida saldo disponible negativo.

**Durabilidad y capacidad**

- Respuesta de aceptación después del commit durable.
- La réplica y el failover deben configurarse para no perder commits reconocidos.
- Ante saturación: rechazos rápidos y explícitos; no acumular solicitudes indefinidamente.
- Liquidación por lotes de 1.000; seguimiento de progreso y reanudación.
- Capacidad y latencia pendientes de validar mediante pruebas.

# Diapositiva 13. Seguridad y fraude
- Público: Gateway y protección de tráfico.
- Privado: servicios, bases, brokers y almacenamiento.
- Administración: acceso privado, doble factor y permisos específicos.
- Roles:
  - Apostador: operar sobre sus apuestas y billetera.
  - Operador: administrar carreras y proponer resultados.
  - Administrador: gestionar permisos y aprobar acciones sensibles.
  - Auditor: consultar sin modificar.
- Validación de firma, expiración y destinatario del JWT.
- Autorización por recurso: conocer un identificador no permite consultar datos ajenos.
- Contraseñas mediante hash resistente con sal; nunca texto plano.
- Cifrado en tránsito y en reposo.
- Secretos gestionados fuera del código y con rotación.
- Rate limiting por usuario y origen; protección contra bots.
- Fraude: cuentas vinculadas por dispositivo, ráfagas inusuales y patrones próximos al cierre.
- Registro de cambios de roles, bloqueos, resultados, cancelaciones y correcciones.
- Corrección de resultados con solicitante y aprobador distintos.
- Bloqueos: distinguir propagación eventual de una revocación que deba ser inmediata. Un JWT válido por sí solo no demuestra que la cuenta siga habilitada.

# Diapositiva 14. Costos e infraestructura compartida
- Seis servicios funcionales; evitar un servicio por cada entidad.
- Escalar por demanda y calendario, con reducción posterior.
- Workers de liquidación activos mientras exista trabajo.
- Compartir infraestructura de bases pequeñas, manteniendo aislamiento lógico.
- Base de Apuestas dedicada por criticidad y volumen de escritura.
- Histórico en almacenamiento económico; almacén analítico para reportes.
- Servicios administrados evaluados según costo total: infraestructura, soporte, operación y recuperación.
- Un clúster compartido por tecnología de mensajería, con aislamiento por topics, colas y permisos.
- Monitorear costo por carrera, almacenamiento, tráfico y procesamiento.
- No hay una cotización validada: el costo depende de proveedor, región, disponibilidad y retención.
- La auditoría procesa eventos de apuestas y movimientos: su volumen puede ser considerable, aunque las consultas sean poco frecuentes.

# Diapositiva 15. Fallos, recuperación y corrección de resultados
| Falla | Comportamiento |
|---|---|
| Notificaciones | Se sigue apostando; los avisos quedan pendientes. |
| Apuestas o su base/billetera | No se aceptan apuestas nuevas sin confirmar el débito. |
| Kafka | El outbox acumula eventos; continuidad condicionada a capacidad disponible. |
| RabbitMQ | Se retrasan tareas; conservar trabajos pendientes y reintentar publicación. |
| Carreras | Las carreras conocidas pueden operar hasta su cierre local; no se pueden confirmar nuevas acciones administrativas. |
| Usuarios | Sesiones verificables pueden continuar; registro e inicio de sesión quedan afectados. |

**Diferencia entre los casos A y B:** notificar es un efecto posterior; descontar fondos es una condición de aceptación.

**Cancelación**

- Registrar estado y evento.
- Detener nuevas apuestas.
- Devolver el 100 % mediante movimientos idempotentes.
- Registrar avance y finalización de devoluciones.

**Precisión necesaria:** la cancelación anticipada es un estado mutable. Una copia con hora fija no basta para conocerla inmediatamente. Debe coordinarse su aplicación con Apuestas o declararse el tratamiento de apuestas recibidas durante la propagación.

**Resultado incorrecto con pagos realizados**

- Suspender pagos pendientes de la versión anterior.
- Crear nueva versión; conservar resultado y liquidación anteriores.
- Registrar motivo, operador y aprobador.
- Generar reversiones contables, sin borrar movimientos.
- Recalcular y pagar con identificadores de la nueva versión.
- Avisar a los afectados y conservar la secuencia completa para auditoría.
- Si el premio ya fue gastado: la propuesta contempla deuda. Para mantener la regla de saldo disponible no negativo, conviene registrar esa deuda separadamente y bloquear nuevas apuestas hasta resolverla.
- La espera preventiva propuesta de dos minutos consume parte de los quince minutos disponibles.

# Diapositiva 16. ADR-001: Arquitectura híbrida
- **Contexto:** alta concentración de apuestas, integridad de saldos y necesidad de controlar complejidad.
- **Opciones:** monolito completo, microservicios por capacidad e híbrida.
- **Decisión:** núcleo modular de apuestas, billetera y premios; servicios separados de apoyo.
- **Beneficios:** transacciones locales, menos coordinación distribuida, escalado independiente de funciones auxiliares.
- **Costos:** escritura concentrada, disponibilidad compartida del núcleo y disciplina necesaria para mantener módulos.
- **Revisión futura:** evidencia de que el núcleo limita despliegue, capacidad o autonomía.
- ADR de máximo una página: contexto, alternativas, decisión y consecuencias.

# Diapositiva 17. ADR-002: Transacción de apuesta y saldo
- **Contexto:** evitar apuestas sin fondos, débitos sin apuesta, duplicados y doble gasto.
- **Opciones:** débito posterior, reserva distribuida o transacción local.
- **Decisión:** apuesta, débito, movimiento, operación idempotente y outbox en un commit.
- **Beneficios:** rollback completo ante fallos; recuperación de respuestas perdidas; restricciones únicas como garantía.
- **Costos:** billetera y apuestas comparten base y frontera de despliegue.
- **Patrón descartado hoy:** saga, porque no existe separación transaccional que la justifique.
- **Condición de revisión:** necesidad comprobada de separar billetera, acompañada de un protocolo de reserva, confirmación, liberación y recuperación.

# Diapositiva 18. ADR-003: Kafka y RabbitMQ
- **Contexto:** múltiples consumidores de hechos, necesidad de reproducción y trabajos masivos reintentables.
- **Opciones:** solo Kafka, solo RabbitMQ, llamadas directas o combinación.
- **Decisión:** Kafka para eventos; RabbitMQ para tareas.
- **Beneficios:** consumidores independientes, historial operativo, distribución de lotes y manejo de reintentos.
- **Costos:** dos tecnologías, dos modelos operativos y mayor superficie de monitoreo y seguridad.
- **Justificación:** responsabilidades distintas y explícitas; no publicar lo mismo en ambos sin necesidad.
- **Alternativa de simplificación:** conservar Kafka y rediseñar la ejecución de trabajos.
- **Límite:** ningún broker garantiza por sí solo que un saldo se modifique exactamente una vez; esa protección corresponde a las transacciones y la idempotencia.

# Diapositiva 19. Arquitectura actual y evolución a 100 veces
**Hoy:** híbrida con núcleo transaccional modular, servicios de apoyo, infraestructura administrada y capacidad preparada por calendario.

| Criterio exigido | Decisión actual y evolución |
|---|---|
| Complejidad | Mantener pocas fronteras distribuidas; separar componentes cuando exista una necesidad medida. |
| Escalabilidad | Optimizar escritura, separar lectura, escalar procesos y después estudiar distribución de datos. |
| Resiliencia | Réplicas, failover, outbox, reintentos e idempotencia; probar recuperación. |
| Consistencia | Conservar invariantes de saldo y apuesta; introducir reservas si se separa billetera. |
| Seguridad | Mantener aislamiento, permisos mínimos y auditoría al incorporar componentes. |
| Costo | Escalar según carga; medir costo por operación y evitar capacidad ociosa. |
| Mantenibilidad | Límites de módulos, contratos versionados, observabilidad y ADR actualizados. |

Secuencia de evolución:

1. Medir cuellos de botella y optimizar consultas y transacciones.
2. Aumentar capacidad de escritura y separar consultas.
3. Aislar recursos de liquidación si compiten con apuestas.
4. Revisar particionado de eventos y consumidores.
5. Separar billetera solo con justificación y protocolo distribuido.
6. Distribuir datos cuando una instancia ya no alcance.

Los umbrales de la presentación son orientativos, no resultados de pruebas. Crecer cien veces desde el pico implica un millón de apuestas por segundo; no está demostrado por el diseño actual.

# Diapositiva 20. Conclusiones, validación y cambio de requisitos
Invariantes del diseño:

- Una operación lógica produce como máximo una apuesta y su débito correspondiente.
- No se acepta una apuesta sin fondos ni fuera de plazo.
- Premios, devoluciones y correcciones quedan identificados y auditados.
- Los consumidores pueden recuperarse y reprocesar sin repetir efectos económicos.
- La capacidad y los tiempos deben comprobarse.

Pruebas necesarias:

- Pico de apuestas y conexiones.
- Cuatro reintentos simultáneos de la misma operación.
- Apuestas diferentes concurrentes sobre una billetera.
- Pérdida de respuesta después del commit.
- Caída y recuperación de brokers.
- Caída de un worker durante el pago.
- Cierre exacto, cancelación y resultado corregido.
- Reconstrucción completa de bolsa, comisión y premios.

**Cambio de requisitos: apuestas en vivo**

- Incorporar mercados o ventanas con identificador, participantes, estado y cierre propios.
- Bolsa y liquidación separadas por mercado.
- Identificar en cada apuesta la ventana correspondiente.
- Aumentar frecuencia de actualización de cuotas.
- Incorporar suspensión por incidentes o información relevante de la pista.
- Propagar suspensiones con garantías acordes al riesgo; la consistencia eventual por sí sola puede ser insuficiente.
- Mantener la misma transacción para validación, débito, apuesta e idempotencia.
- Revisar capacidad y reglas de fraude por el aumento de ventanas y eventos.
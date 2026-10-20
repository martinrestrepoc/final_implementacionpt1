# Outline de presentación

**La Gran Liga de Apuestas de Medianos EIA**

20 diapositivas, incluida la portada. El contenido bajo «En pantalla» es el texto propuesto. Las notas sirven para preparar la exposición y no se proyectan. Las cifras de capacidad son requisitos o estimaciones de diseño, no resultados de pruebas.

## 1. Plataforma de apuestas de Medianos EIA

**En pantalla**

Salchipapa Maker Racing S.A.S.  
Propuesta de arquitectura · Integrantes · Arquitectura de Software, EIA

- 100.000 usuarios conectados en la final.
- 10.000 apuestas/s durante los últimos 30 segundos.
- Confirmación en menos de 1 segundo.
- Ninguna apuesta aceptada ni movimiento de billetera puede perderse.

**Nota para exponer:** explicar en una frase que se apuesta con EIA Coins. Estas cifras describen el escenario que el diseño debe atender.

## 2. Arquitectura seleccionada

**En pantalla**

**Arquitectura híbrida: núcleo modular y cinco servicios independientes.**

| Opción | Razón de la decisión |
|---|---|
| Híbrida, seleccionada | Apuesta y débito comparten transacción. Las tareas externas escalan por separado. |
| Monolito único | Concentra despliegues, carga y fallos en una aplicación. |
| Microservicios por capacidad | Separar Apuestas y Billetera exige reservas y compensaciones. |
| Encolar y validar después | No confirma la aceptación real dentro de la respuesta al usuario. |

**Nota para exponer:** el núcleo incluye Apuestas, Billetera y Liquidación. Las alternativas se descartan por sus costos y riesgos en este caso, no porque sean arquitecturas inválidas en general.

## 3. Servicios y responsabilidades

**En pantalla**

| Servicio | Responsabilidad |
|---|---|
| Core de apuestas | Registrar apuestas, administrar EIA Coins y liquidar premios. |
| Identidad | Usuarios, sesiones, roles y bloqueos. |
| Competencia | Carreras, medianos y resultados oficiales. |
| Notificaciones | Avisos por correo, push e in-app. |
| Analítica y fraude | Estadísticas, cuotas estimadas y detección de patrones sospechosos. |
| Auditoría | Historial inalterable y reconstrucción de premios. |

**API Gateway:** acceso, validación del token y límites de solicitudes.

**Nota para exponer:** Liquidación es un módulo del core con workers que escalan por separado. No es un séptimo servicio. Medianos y Resultados pertenecen a Competencia. El gateway es infraestructura de entrada.

## 4. Diagrama general de arquitectura

**En pantalla**

Insertar la vista integrada de `diagrama-general.md`, con una leyenda visible:

- Comunicación síncrona.
- Eventos de Kafka.
- Comandos de RabbitMQ.

**Texto de apoyo:** «Apuestas y Billetera comparten PostgreSQL. Los demás servicios reciben los eventos que necesitan».

**Elementos que deben verse:** clientes, gateway, seis servicios, bases de datos, brokers y consumidores. Delimitar zona pública y red privada. Señalar que el worker de liquidación pertenece al core.

**Nota para preparar el gráfico:** mantener separados el almacén de auditoría y el de analítica, aunque ambos usen object storage. La bitácora de Notificaciones vive en su PostgreSQL. El acceso administrativo debe pasar por VPN o acceso de confianza cero. Estas precisiones evitan que la simplificación del diagrama sugiera bases compartidas o administración pública.

## 5. Flujo de una apuesta

**En pantalla**

Insertar una versión simplificada de `secuencia-apuesta-principal.mmd`.

1. La app envía la apuesta y su clave de idempotencia.
2. El gateway valida el token.
3. El core verifica usuario, carrera, participante, cierre y saldo.
4. Una transacción registra apuesta, débito, movimiento y outbox.
5. Tras el commit, el usuario recibe la confirmación.

**Fuera de la respuesta:** publicación de eventos, notificaciones y analítica.

**Nota para exponer:** incluir las ramas de carrera cerrada y saldo insuficiente. Las validaciones usan datos locales en el flujo normal. Si falta la proyección de carrera, existe una consulta excepcional a Competencia. Si no puede verificarse, se rechaza. Mostrar la respuesta original cuando la operación ya existe.

## 6. Comunicaciones síncronas: apuesta y sesión

**En pantalla**

| Origen / destino | Protocolo | Información | Motivo y respuesta ante fallo |
|---|---|---|---|
| Cliente / Gateway | HTTPS, WSS | Operaciones y actualizaciones | Respuesta interactiva. Reintento de apuesta con la misma clave. |
| Gateway / Identidad | REST, OIDC | Login, registro, refresh | Obtener sesión. Timeout de 1 s y un reintento. |
| Gateway / Identidad | HTTP, JWKS | Claves públicas | Validar firmas. Consulta periódica con caché. |
| Gateway / Core | gRPC | Apuesta, saldo, movimientos | Confirmación inmediata. Timeout de 800 ms, sin reintento automático de escritura. |
| Core / Competencia | gRPC | Carrera apostable | Solo si falta la proyección. Timeout de 200 ms y un reintento. Si falla, rechazar. |

**Nota para exponer:** la validación normal del JWT no consulta Identidad por cada apuesta. Si cae Identidad, las sesiones vigentes pueden seguir funcionando con las claves disponibles. La conexión WSS es persistente y se usa para push, no para validar el débito.

## 7. Comunicaciones síncronas: consultas y operación

**En pantalla**

| Origen / destino | Protocolo | Información | Motivo y respuesta ante fallo |
|---|---|---|---|
| Gateway / Competencia | REST | Carreras y medianos | Consulta interactiva. 500 ms, un reintento y caché. |
| Competencia / Core | gRPC | Resumen de la bolsa | Panel del operador. 1 s, último valor marcado como aproximado. |
| Gateway / Analítica | REST | Estadísticas premium | Consulta interactiva. 3 s, reporte precalculado. |
| Gateway / Auditoría | REST | Historial y premios | Consulta del auditor. 10 s, paginación o exportación asíncrona. |
| Gateway / Identidad o Competencia | REST | Operaciones administrativas | Confirmar cambios. 2 s, sin reintento automático. |
| Notificaciones / Proveedor | HTTPS | Entrega del mensaje | Confirmación del proveedor. 5 s, reintentos mediante cola. |

**Nota para exponer:** las operaciones administrativas requieren acceso privado y MFA. El proveedor tiene una API síncrona, pero su llamada ocurre fuera del flujo de aceptación de la apuesta.

## 8. Eventos y comunicación asíncrona

**En pantalla**

Todos los eventos de esta tabla usan **Kafka**.

| Evento | Productor | Consumidores | Clave |
|---|---|---|---|
| CarreraAbierta | Competencia | Core, Notificaciones, Analítica | carreraId |
| CarreraCerrada | Competencia | Core, Push, Analítica, Auditoría | carreraId |
| ApuestaAceptada | Core | Analítica/Fraude, Auditoría, Cuotas, Notificaciones | carreraId |
| ResultadoPublicado | Competencia | Liquidación, Notificaciones, Analítica, Auditoría | carreraId |
| MovimientoBilleteraRegistrado | Core | Auditoría, Analítica, Notificaciones | usuarioId |
| LiquidacionCalculada | Liquidación | Auditoría, Analítica | carreraId |
| LiquidacionFinalizada | Liquidación | Competencia, Notificaciones, Auditoría, Observabilidad | carreraId |

**Datos comunes:** eventoId, tipo, versión, fecha y datos del negocio.

**Notas para exponer:**

- `CarreraAbierta`: cierre y participantes. `CarreraCerrada`: carrera y fecha de cierre.
- `ApuestaAceptada`: apuesta, usuario, carrera, mediano, monto y clave de idempotencia.
- `ResultadoPublicado`: ganador, versión, orden de llegada y operador.
- `MovimientoBilleteraRegistrado`: operación, usuario, tipo, monto y saldo resultante.
- `LiquidacionCalculada`: bolsa, comisión, monto distribuible y factor de pago.
- `LiquidacionFinalizada`: versión, cantidad de pagos, monto y duración.
- El sobre completo también incluye productor, clave de partición, correlación y causa.

**Tabla de apoyo en las notas, para completar la Decisión 4 sin saturar la pantalla:**

| Evento, todos en Kafka | Productor | Consumidores | Clave | Datos específicos |
|---|---|---|---|---|
| UsuarioRegistrado | Identidad | Core, Notificaciones, Analítica | usuarioId | Usuario, alias, registro y canales. |
| UsuarioEstadoCambiado | Identidad | Core, Auditoría, Notificaciones | usuarioId | Estados anterior/nuevo, motivo y administrador. |
| CarreraProgramada | Competencia | Notificaciones, Analítica, Auditoría | carreraId | Inicio, pista, distancia y participantes. |
| CarreraIniciada | Competencia | Notificaciones, Push, Analítica | carreraId | Carrera y fecha de inicio. |
| ResultadoCorregido | Competencia | Liquidación, Notificaciones, Auditoría, Analítica | carreraId | Versión, ganadores anterior/nuevo, motivo y aprobadores. |
| CarreraCancelada | Competencia | Core, Notificaciones, Auditoría, Analítica | carreraId | Motivo, fecha y operador. |
| ApuestaRechazada | Core | Analítica/Fraude, Auditoría | carreraId | Usuario, carrera, monto y motivo. |
| CuotasEstimadasActualizadas | Procesador de cuotas | Push, Gateway, Analítica | carreraId | Ventana, montos y cuotas por mediano. |

## 9. Diseño de Kafka y RabbitMQ

**En pantalla**

**Kafka: eventos con historial**

Mostrar productor, topic, particiones, grupos y consumidores:

`Core + outbox → apuestas.aceptadas [24 particiones] → grupos de Analítica, Auditoría, Cuotas y Notificaciones`

Clave: `carreraId`. Cada grupo mantiene su posición de lectura.

**RabbitMQ: trabajos pendientes**

Mostrar productor, exchange, routing key, queue y consumidores:

`Coordinador → liquidacion [direct] → liquidacion.lote → q.liquidacion.lotes → workers`

Reintentos con espera, confirmación manual y cola de errores.

**Nota para exponer:** Kafka permite releer hechos y alimentar varios consumidores. RabbitMQ distribuye tareas y facilita reintentos por mensaje. Mantener ambos agrega costo y operación. La propuesta limita esa carga a un clúster gestionado de cada tecnología.

**Detalle de apoyo:**

- Kafka: `billetera.movimientos`, 24 particiones, clave `usuarioId`. `competencia.carreras` y `competencia.resultados`, 6 particiones, clave `carreraId`.
- Grupos separados: `cg-analitica`, `cg-auditoria`, `cg-cuotas`, `cg-notificaciones` y los grupos propios de los demás consumidores.
- Réplica 3, `acks=all`, mínimo 2 réplicas en sincronía. Confirmar offsets después de procesar.
- RabbitMQ: `EnviarNotificacion`, exchange `notificaciones` de tipo topic, enlaces `notif.email.*`, `notif.push.*`, `notif.inapp.*`, colas por canal y workers por canal. Los productores publican claves concretas que coincidan con esos patrones.
- `RecalcularEstadisticas`: Analítica publica en exchange `analitica`, routing key `analitica.recalculo`, cola `q.analitica.recalculo`, consumidores ETL.
- Colas durables, mensajes persistentes, publisher confirms. Reintentos de 5 s, 30 s y 5 min, hasta 5 intentos y luego DLQ con alerta.
- Ambos brokers pueden entregar mensajes más de una vez. La idempotencia evita repetir sus efectos.

## 10. Idempotencia: cuatro clics, una apuesta

**En pantalla**

**Apuesta de 500 EIA Coins. Cuatro solicitudes con la misma clave. Un solo débito.**

| Operación | Protección |
|---|---|
| Crear una apuesta | Clave única por usuario y respuesta original guardada. |
| Debitar la billetera | Identificador único de operación y actualización condicionada al saldo. |
| Pagar un premio | Clave por apuesta y versión del resultado. Lote procesado una sola vez. |
| Consumir un evento | Registrar eventoId junto con el efecto del consumidor. |

**Visual:** versión breve de `secuencia-apuesta-idempotencia.mmd`.

**Nota para exponer:** la app mantiene la misma clave para los reintentos de una operación. La base de datos es la autoridad. Redis solo acelera consultas. Si el primer intento hizo commit pero perdió la respuesta, el siguiente devuelve la apuesta existente. Una entrega repetida del broker no implica un pago repetido.

## 11. Datos y consistencia

**En pantalla**

| Componente | Almacenamiento |
|---|---|
| Core | PostgreSQL dedicado. Apuesta, saldo, movimientos y outbox en una transacción. |
| Identidad, Competencia, Notificaciones | Bases PostgreSQL separadas. Instancia física compartida al inicio. |
| Analítica y fraude | Data lake y motor OLAP. |
| Auditoría | Almacenamiento WORM, retención mínima de 5 años. |

**Consistencia fuerte:** aceptación, débito y cálculo de premios.  
**Consistencia eventual:** cuotas estimadas, estadísticas y notificaciones.

**Nota para exponer:** cada servicio es dueño de sus datos y no consulta directamente las bases ajenas. Kafka conserva el historial operativo para replay. El data lake conserva el histórico analítico. Auditoría puede llegar después, pero debe quedar completa e inalterable. Outbox conserva el evento junto con la operación. Inbox deduplica su consumo.

## 12. Picos de tráfico y liquidación

**En pantalla**

**300.000 solicitudes de apuesta en 30 segundos.**

- Preescalar gateway, core y push antes de la carrera.
- Proteger PostgreSQL con conexiones limitadas y transacciones cortas.
- Calcular cuotas por streaming, sin actualizar una fila global por apuesta.
- Validar el cierre con el reloj de la base de datos y el saldo con un débito condicional.
- Liquidar en lotes de 1.000 apuestas. Meta: menos de 15 minutos.

**Nota para exponer:** el primario de PostgreSQL es el principal límite de escritura y escala verticalmente en la fase inicial. Los workers aumentan después del pico. La bolsa final reparte el 90 % entre ganadores proporcionalmente a lo apostado, con comisión del 10 %. Una cancelación devuelve el 100 %. Bajo saturación, limitar la admisión y responder explícitamente. Una apuesta solo se considera aceptada después del commit. El outbox conserva sus eventos aunque el broker no esté disponible.

**Validación pendiente:** medir latencia y capacidad con carga real. Tener 24 particiones no distribuye los eventos de una misma carrera entre las 24: con clave `carreraId`, esa carrera cae en una sola partición. También debe probarse ese consumidor durante el pico.

## 13. Seguridad y exposición

**En pantalla**

| Acceso | Componentes |
|---|---|
| Público | CDN/WAF, API Gateway y WebSocket. Login a través del gateway. |
| Privado | Servicios, workers, bases de datos, brokers y almacenamiento. |
| Administrativo | VPN o acceso de confianza cero, MFA y permisos por rol. |

- JWT y autorización sobre cada recurso.
- Cifrado en tránsito y reposo. Secretos fuera del código.
- Límites por usuario e IP y detección de abuso.
- Acciones administrativas registradas. Doble aprobación para corregir resultados.

**Nota para exponer:** distinguir apostador, operador, administrador y auditor. El auditor consulta sin modificar. Un usuario solo puede acceder a sus apuestas y billetera.

## 14. Costos de operación

**En pantalla**

| Decisión | Efecto en el costo |
|---|---|
| Escalado programado | Capacidad adicional durante los eventos. |
| Workers bajo demanda | Cómputo de liquidación mientras haya trabajo. |
| Bases pequeñas en una instancia | Menor costo base, con aislamiento lógico. |
| Servicios gestionados | Menos mantenimiento de infraestructura propia. |
| Históricos en almacenamiento frío | Menor costo de conservación. |

**Costos que se conservan:** PostgreSQL del core con alta disponibilidad y dos brokers.

**Nota para exponer:** el documento propone una base aproximada de $1.400–2.500 al mes y $50–150 adicionales por evento. Son estimaciones del documento, no una cotización. No especifica la moneda, la región ni un dimensionamiento probado, por lo que conviene presentar las decisiones de costo y reservar esas cifras como referencia pendiente de precisar.

## 15. Manejo de fallos

**En pantalla**

| Falla | Respuesta del sistema |
|---|---|
| Notificaciones | Las apuestas continúan. Los avisos quedan pendientes. |
| Core o billetera | No se aceptan nuevas apuestas sin confirmar el débito. |
| Kafka | Los eventos esperan en el outbox. Cuotas y avisos se retrasan. |
| RabbitMQ | Se retrasan liquidaciones y envíos. Los trabajos se reanudan. |
| Respuesta perdida después del commit | El reintento con la misma clave recupera la apuesta. |

**Nota para exponer:** los brokers pueden estar fuera de servicio temporalmente, mientras el almacenamiento pendiente tenga capacidad. Si falta información para verificar una carrera, se rechaza la apuesta. Una caída prolongada de RabbitMQ puede incumplir la meta de liquidación y debe generar una alerta.

**Caso opcional de resultado corregido:** conservar versiones del resultado y agregar asientos de reversión. No borrar pagos previos. El documento plantea una deuda controlada si el usuario ya gastó el premio, pero eso necesita acordarse frente al requisito de saldo no negativo antes de defenderlo como solución cerrada.

## 16. ADR-001: arquitectura híbrida

**En pantalla**

**Contexto:** pico de apuestas, dinero consistente y equipo pequeño.

**Opciones:** monolito único, microservicios por capacidad, validación diferida y arquitectura híbrida.

**Decisión:** core modular y cinco servicios independientes.

**Se gana:** separación de carga y fallos sin distribuir la transacción monetaria.

**Se sacrifica:** el core comparte despliegue y su base concentra las escrituras.

**Formato:** una diapositiva, equivalente a una página. Estado: aceptada. Fecha del registro: 19 de octubre de 2026.

## 17. ADR-002: apuesta y débito en una transacción

**En pantalla**

**Contexto:** no perder apuestas aceptadas ni gastar dos veces el saldo.

**Opciones:** transacción local, saga con reserva, débito posterior o event sourcing con control consistente de fondos.

**Decisión:** guardar apuesta, débito, movimiento y outbox en la misma transacción.

**Se gana:** confirmación conjunta y reintentos sin nuevos cargos.

**Se sacrifica:** Apuestas y Billetera no se despliegan ni escalan de forma independiente.

**Formato:** una diapositiva. Estado: aceptada. Fecha del registro: 19 de octubre de 2026.

## 18. ADR-003: Kafka y RabbitMQ

**En pantalla**

**Contexto:** varios consumidores necesitan historial. Los pagos y avisos necesitan repartir trabajo y reintentarlo.

**Opciones:** Kafka, RabbitMQ, ambos o llamadas directas.

**Decisión:** Kafka para eventos. RabbitMQ para comandos.

**Se gana:** replay independiente y distribución de tareas entre workers.

**Se sacrifica:** dos tecnologías que configurar, supervisar y pagar.

**Formato:** una diapositiva. Estado: aceptada. Fecha del registro: 19 de octubre de 2026.

## 19. Qué implementaríamos hoy y cómo creceríamos 100 veces

**En pantalla**

**Hoy:** core modular, cinco servicios, mensajería gestionada y escalado por calendario.

| Señal de crecimiento | Cambio propuesto |
|---|---|
| Primario saturado | Ajustar capacidad, separar lecturas y evaluar sharding. |
| Liquidación cerca de 15 minutos | Aislar recursos y evaluar extraer Liquidación. |
| Más de 50.000 apuestas/s sostenidas | Evaluar Billetera independiente con reserva y compensación. |
| Usuarios en otras regiones | Evaluar despliegue regional y recuperación ante desastres. |

**Nota para exponer:** 100 veces el pico actual equivale a 1.000.000 de apuestas/s. El documento ofrece una ruta de evolución, no evidencia de capacidad para ese volumen. Conectar la respuesta con los siete criterios: complejidad acotada por módulos, escalabilidad guiada por mediciones, resiliencia por aislamiento, consistencia del dinero, seguridad por fronteras, costo por demanda y mantenibilidad mediante contratos.

**Límites que deben explicarse:** separar Billetera o distribuir los datos sí cambia la coordinación monetaria. Requiere rediseñar esa parte, probar compensaciones y revisar latencia. Más particiones solo ayudan si las claves distribuyen la carga. Una réplica regional asíncrona también obliga a revisar el objetivo de no perder operaciones.

## 20. Conclusiones

**En pantalla**

- Apuesta y débito se confirman juntos.
- Los reintentos conservan una sola operación.
- Notificaciones y analítica pueden retrasarse sin detener la aceptación.
- La capacidad se amplía según la carga medida y el calendario.

**Cierre oral:** «El siguiente paso es probar el pico de apuestas, los reintentos concurrentes y los fallos durante la liquidación».

**Preparación para el cambio de requisitos de la sustentación:** si piden apuestas en vivo, explicar mercados con ventanas de cierre propias, bolsa y liquidación por mercado, nuevas señales de carrera y controles de suspensión. Mantener la transacción de apuesta y débito. Revisar la frescura de las señales antes de aceptar apuestas y medir la mayor carga. Este ejemplo es una preparación, no un requisito confirmado del sistema actual.

---

## Comprobación de cobertura

| Requisito de la imagen | Diapositiva |
|---|---|
| Arquitectura y alternativas | 2 |
| Servicios y responsabilidades | 3 |
| Diagrama general | 4 |
| Diagrama de secuencia | 5 y apoyo en 10 |
| Tabla síncrona | 6–7 |
| Tabla asíncrona | 8 y sus notas |
| Diseño de Kafka/RabbitMQ | 9 |
| Idempotencia | 10 |
| Datos y consistencia | 11 |
| Cargas masivas | 12 |
| Seguridad, público y privado | 13 |
| Costos | 14 |
| Fallos | 15 |
| Tres ADR, máximo una página cada uno | 16–18 |
| Pregunta final | 19 |
| Conclusiones | 20 |

La portada está incluida en las 20 diapositivas. Las tablas de apoyo y las notas no son diapositivas adicionales. La imagen fija grupos de hasta tres integrantes y exposición el 4 o 5 de noviembre. Cada integrante debe poder explicar las decisiones y responder al cambio de requisitos.

Fuentes locales: `decisiones-arquitectura.md`, `contexto-proyecto.md`, `diagrama-general.md`, `diagrama-secuencia-apuesta.md`, `secuencia-apuesta-principal.mmd`, `secuencia-apuesta-idempotencia.mmd`, más la imagen del entregable.

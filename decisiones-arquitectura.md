# Decisiones de Arquitectura — Plataforma de Apuestas "La Gran Liga de Medianos EIA"

**Cliente:** Salchipapa Maker Racing S.A.S.
**Documento:** Registro de decisiones arquitectónicas obligatorias (Decisiones 1 a 9 + seguridad, costos, ADR y pregunta final)
**Fecha:** 19 de octubre de 2026
**Base:** `contexto-proyecto.md` (derivado de `final pt1.pdf`)
**Estado:** Decisiones cerradas. Este documento es la **fuente única de verdad** para construir los diagramas (general, secuencia y mensajería).

---

## 0. Resumen ejecutivo (la arquitectura en 10 líneas)

Diseñamos una **arquitectura híbrida**: un **núcleo transaccional modular** (`core-apuestas`) que contiene **Apuestas + Billetera + Liquidación** en un solo despliegue y una sola base de datos relacional, rodeado de **5 servicios satélite** desacoplados por eventos (Identidad, Competencia, Notificaciones, Analítica y Fraude, Auditoría), detrás de un **API Gateway**.

La decisión central y de la que se derivan casi todas las demás: **la apuesta y el débito de EIA Coins ocurren en la misma transacción ACID local**. Eso elimina la necesidad de sagas en el camino crítico, garantiza que nunca haya doble gasto ni saldo negativo, y permite responder al usuario en menos de 1 segundo incluso con 10.000 apuestas/segundo.

Todo lo que **no** necesita estar en esa transacción (notificar, estadísticas, auditoría, cuotas estimadas, pago de premios masivo) sale del camino crítico por **eventos en Kafka** (hechos del negocio, multi-consumidor, con historial y replay) y por **colas de trabajo en RabbitMQ** (comandos con reintentos, backoff y DLQ).

**6 servicios, no 20.** Una infraestructura que cuesta menos que "la de Netflix" porque los picos son **programados** (el calendario de carreras se conoce de antemano) y se absorben con escalado programado + managed services, no con capacidad permanente.

---

## 1. Decisión 1 — Estilo arquitectónico

### 1.1 Decisión

**Arquitectura híbrida**: *monolito modular transaccional para el dominio del dinero* + *microservicios satélite para las capacidades desacoplables*.

Concretamente:

| Unidad de despliegue | Naturaleza | Por qué así |
|---|---|---|
| `core-apuestas` (Apuestas + Billetera + Liquidación) | **Monolito modular** — 1 artefacto, 1 BD, módulos con fronteras internas explícitas | El dinero exige invariantes transaccionales que no se pueden partir sin pagar un costo altísimo (sagas, reservas, compensaciones) |
| `identidad`, `competencia`, `notificaciones`, `analitica-fraude`, `auditoria` | **Microservicios** independientes, BD propia, despliegue y escalado propios | Tienen ciclos de vida, perfiles de carga y requisitos de consistencia radicalmente distintos |

El `core-apuestas` es **un artefacto con dos perfiles de despliegue**: pods `api` (latencia baja, autoescalado agresivo) y pods `worker-liquidacion` (procesamiento por lotes, bursty). Mismo código, misma BD, distinta forma de escalar. Esto nos da el beneficio operativo de separar la liquidación **sin** pagar el costo de una frontera de red entre la liquidación y el libro mayor de la billetera.

### 1.2 Justificación

1. **El invariante más caro del sistema es monetario**, no de escala: "nunca se pueden gastar dos veces los mismos EIA Coins" y "ninguna apuesta aceptada puede perderse". Mantener Apuestas y Billetera en la misma transacción local convierte el problema más difícil del enunciado (consistencia entre apuesta y débito) en un `BEGIN … COMMIT`. Cualquier arquitectura que los separe debe reintroducir esa garantía con mecanismos mucho más frágiles.
2. **La escala exigida es alta pero acotada y predecible**: 10.000 apuestas/s durante 30 s ≈ 300.000 escrituras. Eso es perfectamente alcanzable con PostgreSQL gestionado + réplicas de lectura + particionado + pooling. No necesitamos fragmentar el dominio para escalar.
3. **Los componentes que sí deben desacoplarse son los no transaccionales**: notificaciones (su caída no puede frenar una apuesta), analítica (millones de registros/día, consistencia eventual aceptable), auditoría (retención de 5 años, solo-escritura/solo-lectura). Estos son los candidatos legítimos a servicio independiente.
4. **Costo y mantenibilidad**: 6 servicios los puede operar un equipo pequeño. 15 servicios con sagas distribuidas, no.

### 1.3 Alternativas descartadas

**Alternativa A — Monolito único (una sola app, una sola BD, todo adentro).**
*Por qué se descarta:* acopla el fallo y el escalado. Una caída o un despliegue del módulo de notificaciones tumbaría las apuestas, violando el requisito explícito "una falla en notificaciones no debe impedir registrar una apuesta". La liquidación de más de un millón de apuestas competiría por CPU y conexiones con el camino crítico de <1 s. Y la analítica (millones de registros/día) presionaría la misma base de datos OLTP que atiende el pico de apuestas. Además imposibilita escalar solo la capa que lo necesita: en la final habría que replicar *todo* el sistema para absorber el pico de apuestas.

**Alternativa B — Microservicios finos (un servicio por capacidad: usuarios, medianos, carreras, apuestas, billetera, resultados, premios, notificaciones, estadísticas, auditoría ≈ 10+ servicios).**
*Por qué se descarta:* Billetera separada de Apuestas obliga a una **saga con reserva de fondos** (reservar → confirmar/liberar) en el camino crítico. Eso significa: 2 saltos de red sincrónicos por apuesta + estados intermedios (`RESERVADO`) + un proceso de compensación por timeouts + fondos "congelados" si una compensación se pierde. A 10.000 apuestas/s, cada salto extra consume presupuesto del SLA de 1 s y multiplica los modos de fallo. Peor aún: si Billetera está caída, la apuesta no se puede aceptar de ninguna forma — la separación agrega complejidad **sin** agregar disponibilidad real para esa operación. También separar "Medianos" y "Resultados" como servicios propios crea servicios de muy bajo tráfico con costo fijo de operación (CI/CD, observabilidad, on-call, BD) que no se amortiza. El enunciado penaliza explícitamente el sobrediseño.

**Alternativa C — Serverless puro orientado a eventos (FaaS + cola para todo, "aceptar la apuesta en una cola y validarla después").**
*Por qué se descarta:* el requisito "el usuario debe saber en menos de 1 segundo si su apuesta fue **aceptada o rechazada**" es incompatible con encolar-y-validar-después: no se puede responder "aceptada" antes de haber verificado saldo, cierre y duplicidad. Además el *cold start* y los límites de concurrencia durante un pico de 30 s son difíciles de garantizar, y las conexiones a PostgreSQL desde miles de funciones concurrentes requieren un proxy adicional. Sí usamos funciones/contenedores efímeros, pero **fuera** del camino crítico (liquidación, notificaciones, ETL).

---

## 2. Decisión 2 — División de servicios

### 2.1 Mapa de servicios (6 + gateway)

| # | Servicio | Módulos internos | Responsabilidad | Base de datos | Perfil de escalado |
|---|---|---|---|---|---|
| 0 | **api-gateway / BFF** (público) | routing, authN de token, rate limiting, WAF, WebSocket push | Único punto de entrada. Valida JWT localmente con JWKS en caché, aplica cuotas, enruta | — (stateless) + Redis para contadores | Horizontal agresivo (y CDN para lecturas) |
| 1 | **identidad** | usuarios, credenciales, roles, sesiones, bloqueos | Registro, login, emisión/rotación de tokens OIDC, RBAC (apostador, operador, administrador, auditor), bloqueo de cuentas | PostgreSQL `identidad` (hashes Argon2id) | Bajo/medio. Pico solo al inicio del evento (login masivo) |
| 2 | **competencia** | **carreras**, **medianos**, **resultados oficiales** | Ciclo de vida de la carrera (PROGRAMADA→ABIERTA→CERRADA→EN_CURSO→FINALIZADA→LIQUIDADA / CANCELADA), participantes, pistas, horarios, registro del resultado oficial y sus correcciones, ficha e historial de cada mediano | PostgreSQL `competencia` | Bajo en escritura, alto en lectura → réplicas + caché/CDN |
| 3 | **core-apuestas** ⭐ | **apuestas**, **billetera**, **liquidación** (perfil worker), proyección local de carreras, outbox | Aceptar/rechazar apuestas, libro mayor de EIA Coins, débitos, créditos, devoluciones, cálculo pari-mutuel y pago de premios | PostgreSQL `core` (Multi-AZ, particionada) | **El más crítico.** API: horizontal + escalado programado. Workers: bursty |
| 4 | **notificaciones** | plantillas, preferencias, envío email / push / in-app, dedupe | Traducir eventos del negocio en mensajes al usuario por los canales disponibles | PostgreSQL pequeña + Redis (dedupe) | Medio, elástico; totalmente desacoplado |
| 5 | **analitica-fraude** | ingesta/ETL, estadísticas premium, **detección de fraude**, cuotas estimadas | Datos históricos, rendimiento de medianos, tendencias, API de estadísticas premium, reglas de fraude (multi-cuenta por dispositivo, apuestas masivas antes del cierre) | Data lake (S3/Parquet) + OLAP (ClickHouse/BigQuery) | Batch/stream, independiente del OLTP |
| 6 | **auditoria** | ingesta append-only, cadena de hashes, API de consulta del auditor | Registro **inalterable** de apuestas, movimientos, premios y cambios de resultado; reconstrucción del cálculo de premios de cualquier carrera; retención ≥5 años | Object storage WORM (S3 Object Lock) + índice de consulta | Escritura constante y baja, lectura esporádica |

⭐ = contiene el dinero. Es el único servicio con invariantes de consistencia fuerte en el camino crítico.

### 2.2 Decisiones de agrupación explícitas (y por qué)

| Pregunta del enunciado | Decisión | Razón |
|---|---|---|
| ¿**Medianos** merece un servicio independiente? | **No.** Es un módulo dentro de `competencia` | Es un catálogo de ~decenas de registros con escritura casi nula, y el 100 % de sus consultas útiles son *junto* con carreras (participantes, historial, victorias). Un servicio propio agregaría un salto de red y un costo fijo de operación para un agregado que nunca cambia solo. Su historial estadístico vive además en `analitica-fraude`, que es quien realmente lo explota |
| ¿**Resultados** y **Premios** son servicios aparte? | **No.** "Resultado oficial" es un módulo de `competencia` (quien conoce la carrera); "Premios/Liquidación" es un módulo de `core-apuestas` desplegado como **worker** | El resultado es un atributo del agregado Carrera. El cálculo de premios necesita leer *todas* las apuestas y escribir *en* la billetera: separarlo de ellas obligaría a mover millones de filas por red y a liquidar con transacciones distribuidas. Como worker del core, cada lote de pagos es una transacción local |
| ¿**Billetera** aparte de **Apuestas**? | **No** (ver ADR-002) | Es la decisión más importante del diseño: mismo proceso, misma BD, misma transacción ⇒ cero doble gasto, cero saldo negativo, cero saga |
| ¿**Fraude** aparte de **Analítica**? | **No.** Mismo servicio, módulos distintos | Ambos consumen exactamente el mismo flujo de eventos de Kafka y necesitan el mismo almacén histórico. Dos despliegues duplicarían ingesta y costo de almacenamiento para la misma información |
| ¿**Auditoría** aparte de **Analítica**? | **Sí**, servicio separado | Requisitos opuestos: la auditoría necesita **inmutabilidad, retención legal de 5 años y aislamiento de acceso** (rol auditor, solo lectura); la analítica necesita reprocesar, reescribir y agregar libremente. Mezclarlas pondría en riesgo la condición de "registro inalterable" |
| ¿**Identidad** aparte? | **Sí** | Frontera de seguridad: contiene contraseñas y datos personales; se despliega y parchea con otro ritmo; y su carga (login masivo al abrir el evento) no correlaciona con la de apuestas. Nunca está en el camino crítico de una apuesta porque el token JWT ya porta la identidad y el rol |
| ¿**Notificaciones** aparte? | **Sí** | Requisito explícito de tolerancia a fallos: su caída no puede afectar una apuesta |

### 2.3 Componentes de infraestructura (nodos para el diagrama)

- **CDN + WAF** (público) — assets, listados de carreras cacheados, protección contra bots.
- **API Gateway** (público) — TLS 1.3, validación JWT, rate limiting, enrutamiento.
- **WS/Push Gateway** (público) — envío de cuotas estimadas y estado de carrera en vivo a 100.000 clientes.
- **Kafka gestionado** (privado) — backbone de eventos de dominio.
- **RabbitMQ gestionado** (privado) — colas de trabajo/comandos.
- **Redis gestionado** (privado) — caché de proyección de carreras abiertas, contadores de rate limit, dedupe de notificaciones, fast-path de idempotencia (no autoritativo).
- **PostgreSQL gestionado** (privado, Multi-AZ) — `core` en instancia dedicada; `identidad`, `competencia`, `notificaciones` como bases lógicas separadas (fase 1 comparten instancia, ver §11).
- **Object storage + OLAP** (privado) — data lake, auditoría WORM, reportes premium.
- **Secrets Manager / KMS**, **observabilidad** (métricas, logs, trazas).

---

## 3. Decisión 3 — Comunicación síncrona

### 3.1 Principio de diseño

> **El camino crítico de una apuesta tiene CERO llamadas síncronas entre servicios.**

Las cuatro validaciones que exige el enunciado antes de aceptar una apuesta se resuelven **todas** dentro del `core-apuestas`, sin red:

| Validación requerida | Cómo se resuelve sin llamada síncrona |
|---|---|
| Que el usuario exista y no esté bloqueado | El **JWT** (firmado por `identidad`, validado con JWKS en caché) porta `usuarioId`, rol y estado. Además el core mantiene una proyección local de usuarios bloqueados alimentada por el evento `UsuarioEstadoCambiado`, y la existencia de billetera implica la del usuario |
| Que la carrera esté abierta y antes del cierre | **Proyección local autoritativa** `carrera_apostable(carrera_id, cierra_en, estado, participantes[])` en la BD del core, poblada por `CarreraAbierta` y invalidada por `CarreraCerrada`/`CarreraCancelada`. `cierra_en` es **inmutable** una vez abierta la carrera, así que una proyección con segundos de retraso sigue siendo correcta para decidir el cierre |
| Que el mediano participe en la carrera | Misma proyección local (`participantes[]`) |
| Que el usuario tenga saldo suficiente | Misma BD, misma transacción (`UPDATE … WHERE saldo >= monto`) |
| Que la apuesta no esté duplicada | Restricción `UNIQUE (usuario_id, idempotency_key)` en la misma BD |

Esto es lo que hace viable el SLA de <1 s a 10.000 req/s: **una apuesta = una transacción local de una sola base de datos.**

### 3.2 Tabla de comunicaciones síncronas

| # | Servicio origen | Servicio destino | Protocolo | Información solicitada | ¿Por qué debe ser síncrona? | Timeout / fallback |
|---|---|---|---|---|---|---|
| S1 | Cliente (web/móvil) | api-gateway | HTTPS/REST (JSON) + WSS | Todas las operaciones del usuario | El usuario espera una respuesta inmediata | 2 s cliente; reintento con **misma** `Idempotency-Key` |
| S2 | api-gateway | identidad | HTTP/REST (OIDC) | Login, refresh de token, registro | Sin token no hay sesión; la respuesta es el token | 1 s, 1 reintento. Si falla: 503 en login. **Las sesiones ya emitidas siguen funcionando** porque el JWT se valida localmente |
| S3 | api-gateway | identidad | HTTP (JWKS, cada 10 min) | Claves públicas para validar firmas | Necesita la clave para validar, pero se **cachea**: no es por petición | Caché con TTL largo + claves anteriores retenidas. Si identidad cae, la validación sigue funcionando |
| S4 | api-gateway | core-apuestas | gRPC | `CrearApuesta`, `ConsultarSaldo`, `ListarMisApuestas`, `ConsultarMovimientos` | El usuario debe saber en <1 s si su apuesta fue aceptada o rechazada, y el saldo es dato autoritativo (no se puede servir de caché) | 800 ms, **sin reintento automático en escritura** (el cliente reintenta con la misma clave de idempotencia); circuit breaker → 503 `REINTENTAR`. Nunca se responde "aceptada" sin commit |
| S5 | api-gateway | competencia | HTTP/REST | Listado de carreras, detalle de carrera, ficha e historial de mediano | Consulta interactiva del usuario | 500 ms, 1 reintento; fallback a **caché CDN/Redis** (tolera segundos de desactualización) |
| S6 | core-apuestas | competencia | **gRPC — solo en fallo de caché** | `ObtenerCarreraApostable(carreraId)`: estado, `cierra_en`, participantes | Solo se invoca si la proyección local no tiene la carrera (arranque en frío o evento perdido). **No está en el camino normal** | 200 ms, 1 reintento. Si falla: **se rechaza la apuesta (fail-closed)** con `CARRERA_NO_VERIFICABLE`. Nunca se acepta una apuesta sobre una carrera cuyo cierre no se puede verificar |
| S7 | competencia | core-apuestas | gRPC | `ObtenerResumenBolsa(carreraId)` para el panel del operador (totales apostados) | El operador necesita el dato real en pantalla antes de autorizar el inicio | 1 s; fallback: muestra el último valor conocido marcado como "aproximado" |
| S8 | api-gateway | analitica-fraude | HTTP/REST | Estadísticas premium, cuotas históricas, tendencias | Consulta interactiva de un cliente que paga por el reporte | 3 s (consultas OLAP); fallback: reporte precalculado del día anterior (el SLA permite hasta 1 día de retraso) |
| S9 | api-gateway (rol auditor) | auditoria | HTTP/REST (solo lectura) | Consulta del registro inalterable, reconstrucción del cálculo de premios | Consulta interactiva del auditor | 10 s (consultas largas → respuesta paginada o exportación asíncrona) |
| S10 | api-gateway (rol admin/operador) | identidad / competencia | HTTP/REST (red privada + MFA) | Operaciones administrativas: roles, bloqueos, crear/abrir/cancelar carrera, publicar resultado | Requieren confirmación inmediata y quedan auditadas | 2 s, sin reintento automático (son operaciones con efectos; el operador reintenta explícitamente con clave de idempotencia) |
| S11 | notificaciones | Proveedores externos (SMTP, FCM/APNs) | HTTPS | Entrega del mensaje | La API del proveedor es síncrona | 5 s, 3 reintentos con backoff exponencial vía RabbitMQ; luego DLQ. **Jamás afecta al apostador** |

### 3.3 Política general de fallos síncronos

- **Timeouts cortos y explícitos** en todas las llamadas (nunca el default del cliente HTTP).
- **Reintento solo en operaciones idempotentes o de lectura**; las escrituras las reintenta el cliente con la misma `Idempotency-Key`.
- **Circuit breaker** por destino (abre tras N fallos, half-open con sondeo).
- **Bulkheads**: pools de conexiones separados por dependencia, para que un destino lento no agote los hilos del servicio.
- **Degradación según el tipo de dato**: lecturas informativas → caché obsoleta aceptable; decisiones que afectan dinero → **fail-closed** (rechazar es recuperable; aceptar mal, no).

---

## 4. Decisión 4 — Comunicación asíncrona (eventos)

### 4.1 Convención de nombres

**Idioma único: español.** Formato `SustantivoVerboEnParticipio` en `PascalCase`, siempre en **pasado** (son hechos consumados, no órdenes): `ApuestaAceptada`, `CarreraCerrada`, `ResultadoPublicado`.
Los mensajes de RabbitMQ **no** son eventos sino **comandos**, y se nombran en **imperativo** para distinguirlos sin ambigüedad: `EnviarNotificacion`, `LiquidarLote`.

### 4.2 Sobre los eventos sugeridos: qué fusionamos, qué agregamos y por qué

| Evento sugerido por el enunciado | Nuestra decisión |
|---|---|
| `ApuestaRealizada` | **Renombrado** a `ApuestaAceptada`. Solo publicamos el hecho cuando la apuesta fue aceptada **y comprometida** en la BD; "realizada" es ambiguo (¿intentada?). Agregamos `ApuestaRechazada` porque el fraude y la analítica necesitan los rechazos |
| `CarreraIniciada` | **Se mantiene** (transición CERRADA→EN_CURSO) |
| `CarreraFinalizada` + `ResultadoPublicado` | **Fusionados en `ResultadoPublicado`.** En este negocio la carrera pasa a FINALIZADA precisamente cuando se registra el resultado oficial: dos eventos describirían el mismo hecho y obligarían a los consumidores a correlacionarlos. Un solo evento, con el resultado en el payload, dispara a la vez la notificación "terminó la carrera" y la liquidación |
| `PremioCalculado` | **Reemplazado por `LiquidacionCalculada`**, de granularidad **por carrera**, no por apuesta. Un evento por apuesta serían >1.000.000 de eventos por carrera para transportar un dato derivable. `LiquidacionCalculada` contiene la bolsa, la comisión y el **factor de pago por unidad apostada**, que es exactamente lo que la auditoría necesita para reconstruir cualquier premio |
| `PremioPagado` | **Absorbido por `MovimientoBilleteraRegistrado`** con `tipo=CREDITO_PREMIO`. Tener tres eventos casi idénticos (débito de apuesta, pago de premio, devolución) duplicaría esquemas y consumidores: el libro mayor es un solo flujo de movimientos tipificados, y cada consumidor filtra por `tipo` |
| `CarreraCancelada` | **Se mantiene** |
| — | **Agregados:** `CarreraProgramada`, `CarreraAbierta` (crítico: lleva `cierra_en` y participantes a la proyección del core), `CarreraCerrada`, `ResultadoCorregido` (caso C), `LiquidacionFinalizada` (cierra el SLA de 15 min), `MovimientoBilleteraRegistrado`, `CuotasEstimadasActualizadas`, `UsuarioRegistrado`, `UsuarioEstadoCambiado` |

### 4.3 Sobre (envelope común a todos los eventos)

Todo evento viaja con el mismo sobre; `datos` es lo específico del negocio:

```json
{
  "eventoId": "uuid-v7",                  // idempotencia del consumidor
  "tipo": "ApuestaAceptada",
  "version": 1,                            // evolución de esquema
  "ocurridoEn": "2026-11-04T20:14:59.812Z",// UTC, reloj del productor (servidor)
  "productor": "core-apuestas",
  "claveParticion": "carrera-8821",
  "correlacionId": "uuid",                 // traza extremo a extremo
  "causaId": "uuid",                       // evento o petición que lo originó
  "datos": { }
}
```

### 4.4 Tabla de eventos asíncronos

| # | Evento | Productor | Broker | Topic / Exchange | Consumidor(es) | Clave de partición / routing key | Información mínima (`datos`) |
|---|---|---|---|---|---|---|---|
| E1 | `UsuarioRegistrado` | identidad | **Kafka** | `identidad.usuarios` (3 part.) | core-apuestas (crea billetera en 0), notificaciones (bienvenida), analitica | `usuarioId` | usuarioId, alias, fechaRegistro, canalesContacto |
| E2 | `UsuarioEstadoCambiado` | identidad | **Kafka** | `identidad.usuarios` | core-apuestas (proyección de bloqueados), auditoria, notificaciones | `usuarioId` | usuarioId, estadoAnterior, estadoNuevo, motivo, actorAdminId |
| E3 | `CarreraProgramada` | competencia | **Kafka** | `competencia.carreras` (6 part.) | notificaciones, analitica, auditoria | `carreraId` | carreraId, inicioProgramado, pista, distancia, participantes[] |
| E4 | **`CarreraAbierta`** | competencia | **Kafka** | `competencia.carreras` | **core-apuestas (crítico: crea la proyección apostable)**, notificaciones, analitica | `carreraId` | carreraId, **cierraEn** (= hora de inicio), participantes[{medianoId}], abiertaEn |
| E5 | `CarreraCerrada` | competencia | **Kafka** | `competencia.carreras` | core-apuestas (marca no apostable y congela bolsa), ws-gateway, analitica, auditoria | `carreraId` | carreraId, cerradaEn |
| E6 | `CarreraIniciada` | competencia | **Kafka** | `competencia.carreras` | notificaciones, ws-gateway, analitica | `carreraId` | carreraId, iniciadaEn |
| E7 | **`ResultadoPublicado`** (fusiona CarreraFinalizada) | competencia | **Kafka** | `competencia.resultados` (6 part.) | **core-apuestas/liquidación (dispara el pago)**, notificaciones, analitica, auditoria | `carreraId` | carreraId, versionResultado=1, ganadorMedianoId, ordenLlegada[], tiempos, publicadoEn, operadorId |
| E8 | `ResultadoCorregido` | competencia | **Kafka** | `competencia.resultados` | core-apuestas/liquidación (liquidación compensatoria), notificaciones, auditoria, analitica | `carreraId` | carreraId, versionResultado=N, ganadorAnterior, ganadorNuevo, motivo, operadorId, aprobadorId |
| E9 | `CarreraCancelada` | competencia | **Kafka** | `competencia.carreras` | core-apuestas (devolución 100 %), notificaciones, auditoria, analitica | `carreraId` | carreraId, motivo, canceladaEn, operadorId |
| E10 | **`ApuestaAceptada`** | core-apuestas (vía outbox) | **Kafka** | `apuestas.aceptadas` (**24 part.**) | analitica-fraude, auditoria, **stream de cuotas**, notificaciones | **`carreraId`** | apuestaId, usuarioId, carreraId, medianoId, monto, aceptadaEn, idempotencyKey |
| E11 | `ApuestaRechazada` | core-apuestas | **Kafka** | `apuestas.rechazadas` (6 part.) | analitica-fraude (patrones de bot), auditoria | `carreraId` | usuarioId, carreraId, medianoId, monto, motivo (CERRADA/SALDO/DUPLICADA/BLOQUEADO), rechazadaEn |
| E12 | `CuotasEstimadasActualizadas` | stream processor (Kafka Streams sobre E10) | **Kafka** | `cuotas.estimadas` (6 part., compactado) | ws-gateway (push a clientes), api-gateway (caché), analitica | `carreraId` | carreraId, ventana, porMediano[{medianoId, montoAcumulado, cuotaEstimada}], calculadoEn |
| E13 | `LiquidacionCalculada` | core-apuestas/liquidación | **Kafka** | `liquidacion.eventos` (6 part.) | **auditoria (clave para reconstruir premios)**, analitica | `carreraId` | carreraId, versionResultado, bolsaTotal, comision (10 %), montoDistribuible, montoApostadoGanador, **factorPago**, cantidadApuestasGanadoras, calculadoEn |
| E14 | **`MovimientoBilleteraRegistrado`** (absorbe PremioPagado) | core-apuestas (vía outbox) | **Kafka** | `billetera.movimientos` (**24 part.**) | auditoria, analitica, notificaciones (filtra CREDITO_PREMIO y DEVOLUCION) | **`usuarioId`** | movimientoId, usuarioId, tipo (DEBITO_APUESTA / CREDITO_PREMIO / DEVOLUCION / AJUSTE_REVERSION), monto, saldoResultante, operacionId, carreraId?, apuestaId?, registradoEn |
| E15 | `LiquidacionFinalizada` | core-apuestas/liquidación | **Kafka** | `liquidacion.eventos` | competencia (carrera → LIQUIDADA), notificaciones, auditoria, observabilidad (SLA 15 min) | `carreraId` | carreraId, versionResultado, apuestasPagadas, montoPagado, duracionMs, finalizadaEn |

### 4.5 Comandos en RabbitMQ (trabajo, no hechos)

| # | Comando | Productor | Exchange (tipo) | Routing key | Cola(s) | Consumidor | Por qué cola y no stream |
|---|---|---|---|---|---|---|---|
| C1 | `LiquidarLote` | core-apuestas (coordinador, al recibir E7/E8) | `liquidacion` (direct) | `liquidacion.lote` | `q.liquidacion.lotes` (+ `q.liquidacion.lotes.dlq`) | `worker-liquidacion` (N instancias **competing consumers**) | Reparto dinámico de ~1.000 lotes de 1.000 apuestas entre N workers, con `prefetch`, `ack` manual y reentrega automática si un worker muere a mitad del lote |
| C2 | `EnviarNotificacion` | notificaciones (fan-out interno desde eventos Kafka) | `notificaciones` (topic) | `notif.email.*`, `notif.push.*`, `notif.inapp.*` | `q.notif.email`, `q.notif.push`, `q.notif.inapp` (+ DLQ y `q.notif.retry` con TTL) | workers por canal | Reintentos **por mensaje** con backoff (TTL + dead-letter), sin bloquear el resto de la cola. En Kafka un mensaje envenenado bloquea el avance del offset de su partición |
| C3 | `RecalcularEstadisticas` | analitica (planificador) | `analitica` (direct) | `analitica.recalculo` | `q.analitica.recalculo` | workers ETL | Trabajo por lotes, idempotente, con prioridad y cancelable |

### 4.6 Garantías y manejo de errores en el consumo

- **Todos los consumidores son idempotentes** (ver Decisión 6): Kafka y RabbitMQ entregan *al menos una vez*.
- **Kafka**: `acks=all`, `min.insync.replicas=2`, RF=3, `enable.idempotence=true` en productores, commit de offsets **después** de procesar, consumer group por servicio. Retención: 7 días en topics operativos, **compactado** en `cuotas.estimadas`, y volcado continuo a object storage para auditoría/analítica (5 años).
- **RabbitMQ**: colas *durable*, mensajes *persistent*, publisher confirms, `ack` manual, `x-dead-letter-exchange` en todas las colas, reintentos con TTL creciente (5 s → 30 s → 5 min), máximo 5 intentos y luego DLQ con alerta.
- **Pérdida cero de eventos del lado del productor**: ningún servicio publica directamente al broker dentro de la transacción de negocio. Se usa **transactional outbox**: la escritura de negocio y la fila del outbox se comprometen juntas; un *relay* publica y marca la fila como publicada. Si el broker está caído, el negocio sigue funcionando y los eventos salen después, en orden.

---

## 5. Decisión 5 — RabbitMQ vs. Kafka

### 5.1 Decisión

**Usamos ambos, con una frontera estricta y sin ambigüedad:**

| | **Kafka** | **RabbitMQ** |
|---|---|---|
| **Qué transporta** | **Hechos** del negocio (eventos en pasado) | **Trabajo** por hacer (comandos en imperativo) |
| **Patrón** | Publish/subscribe con *log* persistente; cada consumer group lee a su ritmo | Work queue; *competing consumers* se reparten las tareas |
| **Se usa para** | `ApuestaAceptada`, `ResultadoPublicado`, `MovimientoBilleteraRegistrado`, todos los eventos de carrera, cuotas (streams) | `LiquidarLote`, `EnviarNotificacion`, `RecalcularEstadisticas` |
| **Por qué ahí** | Un mismo hecho interesa a 4 consumidores independientes (analítica, fraude, auditoría, notificaciones); hace falta **historial y replay** (reconstruir auditoría, recalcular estadísticas, reprocesar tras un bug); el volumen es alto (10.000 msg/s); y hace falta **agregación en streaming** para las cuotas estimadas | Hace falta **reintento por mensaje con backoff y DLQ** sin bloquear la cola, reparto dinámico de carga entre workers, y control de prioridad/concurrencia por canal |
| **Instancia** | 1 cluster gestionado, 3 brokers (MSK / Confluent Cloud) | 1 cluster gestionado pequeño (Amazon MQ / CloudAMQP) |

### 5.2 Por qué la ventaja compensa mantener dos tecnologías

El enunciado exige justificar explícitamente el costo de la doble tecnología. Nuestra justificación:

**Si usáramos solo Kafka:**
- El reintento de un envío de correo que falla por el proveedor requiere *retry topics* escalonados (`notif.retry.5s`, `retry.30s`, `retry.5m`) + un bucle de republicación, es decir, **reimplementar RabbitMQ a mano**.
- Un mensaje envenenado **bloquea el offset de su partición** (head-of-line blocking): una notificación imposible de entregar detendría las notificaciones de todos los usuarios de esa partición.
- El reparto de 1.000 lotes de liquidación entre N workers está limitado por el número de particiones (un consumidor por partición): para escalar workers hay que reparticionar el topic. Con una cola, agregar workers es inmediato.

**Si usáramos solo RabbitMQ:**
- **No hay replay**: una vez consumido el mensaje, se va. Perderíamos la capacidad de reconstruir la auditoría o recalcular estadísticas tras un bug, que son requisitos del enunciado (histórico de eventos, reproducir eventos).
- **Fan-out con historial independiente es costoso**: cada consumidor necesita su propia cola enlazada, y si uno está caído su cola crece sin control (los mensajes son copias, no punteros a un log compartido).
- **No hay stream processing**: las cuotas estimadas se calculan como una agregación por ventanas sobre `ApuestaAceptada`; eso es nativo en Kafka Streams y ajeno a RabbitMQ.
- El volumen de 10.000 eventos/s sostenidos con 4 copias por evento (4 consumidores) ≈ 40.000 msg/s a mantener en memoria del broker: posible, pero mucho más caro y frágil que un log en disco secuencial.

**Cómo acotamos la complejidad añadida:**
1. Ambos son **servicios administrados**: cero operación de clusters, cero patching, backups y HA incluidos (Dyllan no paga un equipo de plataforma).
2. **Un solo cluster de cada uno**, no uno por servicio (explícitamente evitamos los "6 clusters de Kafka y 4 de RabbitMQ" que el enunciado ridiculiza).
3. **Una sola regla mental** para el equipo: *¿es un hecho que le puede interesar a varios y que quiero poder releer? → Kafka. ¿Es una tarea que alguien debe ejecutar y puede fallar y reintentarse? → RabbitMQ.*
4. Librería interna compartida (sobre de evento, outbox, inbox de deduplicación) para que un desarrollador no tenga que conocer los detalles de ambos brokers.
5. **Plan B de costos explícito:** si la plataforma arranca pequeña, RabbitMQ puede sustituirse por una cola gestionada trivial (SQS) o incluso por una tabla de trabajos en PostgreSQL; Kafka es el que no tiene sustituto razonable dados los requisitos de replay y multi-consumidor. Es decir: **si hubiera que elegir uno solo, elegiríamos Kafka** y aceptaríamos implementar reintentos escalonados a mano.

---

## 6. Decisión 6 — Idempotencia

> *"Ningún mediano debe recibir dos premios porque alguien presionó cuatro veces el botón."*

### 6.1 Principio

Nunca confiamos en "no reintentes": el cliente reintenta, la red duplica y los brokers entregan *al menos una vez*. Por eso **toda operación que mueve dinero o crea un hecho tiene una clave de negocio única, y la unicidad se garantiza en la base de datos**, no en memoria ni en caché. Redis puede acelerar la detección, pero el árbitro final es siempre una **restricción UNIQUE** en PostgreSQL dentro de la misma transacción que hace el cambio.

### 6.2 Operaciones con riesgo de duplicación y su mecanismo

#### Operación 1 — Crear una apuesta (el caso guía: 4 clics)

- La **app genera una `Idempotency-Key` (UUID v4) al montar el formulario**, no al enviar. Los 4 clics envían **la misma clave**.
- `POST /apuestas` con cabecera `Idempotency-Key`. En el core:

```sql
BEGIN;
  -- 1) Cierre: el reloj autoritativo es el de la BD (una sola fuente de tiempo)
  SELECT cierra_en, estado, participantes FROM carrera_apostable
    WHERE carrera_id = :carrera FOR SHARE;
  -- rechazar si estado <> 'ABIERTA' o now() >= cierra_en o mediano no participa

  -- 2) Débito atómico: impide saldo negativo Y doble gasto
  UPDATE billetera SET saldo = saldo - :monto, version = version + 1
    WHERE usuario_id = :usuario AND saldo >= :monto;
  -- 0 filas afectadas => SALDO_INSUFICIENTE, ROLLBACK

  -- 3) La apuesta: la UNIQUE es la que mata los duplicados
  INSERT INTO apuesta (id, usuario_id, carrera_id, mediano_id, monto, idempotency_key, creada_en)
    VALUES (...);                       -- UNIQUE (usuario_id, idempotency_key)

  -- 4) Movimiento en el libro mayor
  INSERT INTO movimiento (id, usuario_id, tipo, monto, operacion_id, saldo_resultante)
    VALUES (..., 'DEBITO_APUESTA', :monto, 'apuesta:'||:apuestaId, ...);
                                        -- UNIQUE (usuario_id, operacion_id)

  -- 5) Evento en el outbox, en la MISMA transacción
  INSERT INTO outbox (evento_id, tipo, clave_particion, payload) VALUES (...);
COMMIT;
```

- Si la clave ya existía, el `INSERT` viola la restricción única → capturamos la violación, hacemos `ROLLBACK` y **devolvemos la respuesta original** (`200 OK` con la apuesta ya creada, no `409`), para que el usuario vea un resultado coherente tras sus 4 clics: **una sola apuesta, un solo débito de 500 EIA Coins**.
- Tabla `operacion_idempotente(usuario_id, idempotency_key, estado, respuesta_json, creada_en, expira_en)` guarda la respuesta canónica; TTL de 7 días. Los reintentos concurrentes que llegan mientras la primera transacción está en vuelo se serializan en la misma fila (insert de `EN_PROCESO` → el segundo espera o recibe `409 EN_PROCESO, reintenta`).
- **Importante:** la clave está **ámbito del usuario** (`usuario_id` + clave), para que un atacante no pueda adivinar claves ajenas y leer o bloquear operaciones de otros.

#### Operación 2 — Cobrar/debitar la billetera (doble gasto y saldo negativo)

- El débito **nunca** es `leer-saldo → decidir → escribir`. Es un `UPDATE … SET saldo = saldo - :monto WHERE usuario_id = :u AND saldo >= :monto` condicional, que toma el **lock de fila** y serializa las apuestas paralelas del mismo usuario. Diez clics simultáneos con claves distintas y saldo para cinco → exactamente cinco aceptadas, cinco rechazadas por saldo, saldo final ≥ 0. **Nunca negativo.**
- Cada movimiento tiene `UNIQUE (usuario_id, operacion_id)`, con `operacion_id` derivado determinísticamente del hecho que lo causa (`apuesta:{apuestaId}`), no un autoincremental. Reproducir la operación no puede duplicar el asiento.
- El saldo es una **columna derivada** actualizada en la misma transacción que inserta el movimiento, de modo que `saldo == SUM(movimientos)` es verificable; un job de conciliación lo comprueba por muestreo y alerta ante cualquier divergencia.

#### Operación 3 — Pagar un premio (que un mediano no pague dos veces)

- `operacion_id = 'premio:{apuestaId}:v{versionResultado}'` con `UNIQUE (usuario_id, operacion_id)`. Si el worker muere después de acreditar y antes de confirmar el lote, al reintentar el `INSERT` del movimiento falla por duplicado y el pago **no se repite**.
- El lote es la unidad de trabajo: `liquidacion_lote(carrera_id, version_resultado, lote_nro, estado, apuestas_desde, apuestas_hasta)` con `UNIQUE (carrera_id, version_resultado, lote_nro)`. Cada mensaje `LiquidarLote` de RabbitMQ se procesa en **una transacción local** que acredita las billeteras del lote, inserta sus movimientos y marca el lote `PROCESADO`. Reentrega del mensaje → el lote ya está `PROCESADO` → `ack` sin hacer nada.
- `LiquidacionCalculada` se emite una sola vez por `(carreraId, versionResultado)` gracias a `UNIQUE (carrera_id, version_resultado)` en la tabla `liquidacion`.
- La **devolución por cancelación** usa `operacion_id = 'devolucion:{apuestaId}'`, exactamente el mismo patrón.

#### Operación 4 — Consumir un evento que llega más de una vez (at-least-once)

- Patrón **inbox**: cada consumidor tiene `evento_procesado(consumer_group, evento_id)` con clave primaria compuesta. El `INSERT` del `evento_id` y el efecto de negocio van en **la misma transacción**; si el `INSERT` falla por duplicado, el evento ya se procesó y se hace `ack` sin reprocesar.
- Donde es posible, buscamos **idempotencia natural** y nos ahorramos la tabla: la proyección `carrera_apostable` se escribe con `UPSERT` y descarta eventos con `ocurridoEn` anterior al registrado; la analítica hace `UPSERT` por clave de agregación; la auditoría hace `INSERT … ON CONFLICT (evento_id) DO NOTHING`.
- **Orden garantizado donde importa**: la clave de partición (`carreraId` para eventos de carrera/apuesta, `usuarioId` para movimientos) asegura que todos los eventos de una misma carrera o de una misma billetera llegan ordenados a un mismo consumidor.

#### Operación 5 — Publicar un evento (que no se pierda ni se duplique sin control)

- **Transactional outbox** + relay con `enable.idempotence=true` en el productor de Kafka. El relay puede publicar el mismo `eventoId` dos veces ante un fallo de red; la deduplicación del consumidor (Operación 4) lo neutraliza. El `eventoId` es un UUID v7 generado al escribir el outbox, estable entre reintentos.

#### Operación 6 — Enviar una notificación (no avisar dos veces "ganaste")

- Clave de deduplicación `(usuarioId, tipoNotificacion, agregadoId, canal)` en Redis con TTL de 24 h, respaldada por una tabla de envíos. No es dinero, así que aquí sí aceptamos un almacén más barato: el peor caso es un correo repetido, no un premio repetido.

#### Operaciones administrativas

- Publicar un resultado, cancelar una carrera o cambiar un rol también aceptan `Idempotency-Key`, y el estado se cambia con una **transición condicionada** (`UPDATE carrera SET estado='CERRADA' WHERE id=:c AND estado='ABIERTA'`). Doble clic del operador = una sola transición.

### 6.3 Resumen de restricciones únicas (insumo para el diagrama de datos)

| Tabla | Restricción única | Qué duplicado impide |
|---|---|---|
| `apuesta` | `(usuario_id, idempotency_key)` | Cuatro clics = una apuesta |
| `movimiento` | `(usuario_id, operacion_id)` | Doble débito, doble pago de premio, doble devolución |
| `liquidacion` | `(carrera_id, version_resultado)` | Doble cálculo de la bolsa |
| `liquidacion_lote` | `(carrera_id, version_resultado, lote_nro)` | Doble procesamiento de un lote |
| `evento_procesado` | `(consumer_group, evento_id)` | Doble consumo de un evento |
| `outbox` | `(evento_id)` | Doble registro de un evento a publicar |
| `operacion_idempotente` | `(usuario_id, idempotency_key)` | Respuesta incoherente ante reintentos |

---

## 7. Decisión 7 — Grandes volúmenes (10.000 apuestas/s durante 30 s)

Carga objetivo: **100.000 usuarios conectados**, **10.000 apuestas/s** en los 30 s previos al cierre ≈ **300.000 apuestas** en media hora de evento, con respuesta en **<1 s** y **pérdida cero**.

### 7.1 Cuellos de botella identificados y su solución

| # | Cuello de botella | Por qué aparece | Solución de diseño |
|---|---|---|---|
| B1 | **Fila "caliente" del total de la bolsa por carrera** | Si cada apuesta actualizara `bolsa.total_apostado` de la carrera, las 10.000 apuestas/s competirían por **una sola fila** → serialización total. Es el cuello de botella más grave y el menos obvio | **No se mantiene ningún contador transaccional de la bolsa.** La bolsa autoritativa se **calcula al cierre** con un `SELECT SUM(monto) … GROUP BY mediano_id` sobre la tabla de apuestas (ya cerrada e inmutable). Las **cuotas estimadas** que se muestran en vivo se calculan **fuera de la BD**, por agregación en ventanas de 1 s en Kafka Streams sobre `ApuestaAceptada`. El enunciado lo permite explícitamente: la cuota mostrada es *aproximada*. **Esto elimina la contención sin perder exactitud donde importa** |
| B2 | Fila de la billetera del mismo usuario | Apuestas paralelas del mismo usuario se serializan en su fila | Es **deseable**: así se garantiza saldo no negativo. El throughput por fila (cientos de operaciones/s) supera por mucho lo que un humano genera. Se mitiga con transacciones **muy** cortas (sin llamadas de red dentro del `BEGIN…COMMIT`) |
| B3 | Inserciones en `apuesta` (10.000/s) | Volumen de escritura e índices | Tabla **particionada por `carrera_id`** (partición nueva por carrera grande): índices más pequeños, y al liquidar se escanea solo su partición. Claves primarias **UUID v7** (ordenadas en el tiempo → sin fragmentación de índice). Commit grupal (`commit_delay`) y `synchronous_commit=on` sobre almacenamiento NVMe |
| B4 | Conexiones a PostgreSQL | Cientos de pods × pool = miles de conexiones | **PgBouncer** en modo transacción (managed proxy): miles de conexiones de cliente sobre ~200 conexiones reales. Pools separados por tipo de operación (bulkheads) |
| B5 | Lecturas (listado de carreras, saldo, cuotas) compitiendo con escrituras | 100.000 usuarios refrescando pantalla | **Separación de caminos**: listados y fichas → CDN + Redis (TTL corto); cuotas en vivo → **WebSocket push** (un cálculo, 100.000 envíos) en lugar de *polling* (100.000 consultas/s); saldo → réplica de lectura, con lectura del primario solo tras una escritura propia (*read-your-writes* por sesión) |
| B6 | TLS / API Gateway | 100.000 conexiones simultáneas | Gateway stateless con autoescalado + terminación TLS en el borde + HTTP/2. Validación de JWT **local** (sin llamar a `identidad`) |
| B7 | Publicación a Kafka dentro de la transacción | Un broker lento frenaría las apuestas | **Outbox**: la transacción solo inserta una fila local. El relay publica después, de forma asíncrona y por lotes |
| B8 | Liquidación de >1.000.000 de apuestas | No cabe en una petición HTTP | Troceado en **lotes de 1.000** publicados como comandos `LiquidarLote` en RabbitMQ y procesados por N workers en paralelo (ver §7.4) |

### 7.2 Qué escala y qué no (insumo directo para el diagrama)

| Componente | ¿Escala en el pico? | Cómo |
|---|---|---|
| CDN / WAF | Sí, automáticamente | Servicio gestionado |
| api-gateway | **Sí, mucho** | Horizontal, autoescalado por RPS + **escalado programado** |
| ws-push-gateway | **Sí, mucho** | Horizontal; 100.000 conexiones ≈ 20 instancias de 5.000 conexiones |
| core-apuestas (api) | **Sí, mucho** | Horizontal (stateless), autoescalado por latencia p99 y RPS + pre-escalado programado |
| PostgreSQL `core` (primario) | **Verticalmente** (no horizontal en fase 1) | Es el único componente no horizontal del camino crítico: se dimensiona para 3× el pico medido y se sube de instancia antes del evento. Las lecturas se desvían a réplicas |
| core-apuestas (workers de liquidación) | Sí, **después** del pico | De 0 a N instancias al recibir `ResultadoPublicado`; vuelven a 0 al terminar (spot/serverless) |
| competencia | **No** (apenas) | Decenas de escrituras por semana. Escala solo su capa de lectura vía caché |
| identidad | Moderadamente | Pico de logins al abrir el evento, no durante el pico de apuestas |
| notificaciones | Sí, pero **con retraso aceptable** | Los workers drenan la cola a su ritmo; el *backlog* es una característica, no un fallo |
| analitica-fraude | **No en tiempo real** | Consume Kafka a su ritmo; minutos de retraso permitidos |
| auditoria | **No** | Escritura secuencial append-only, barata |
| Kafka | Sí, por particiones | 24 particiones en `apuestas.aceptadas` → 24 consumidores por grupo |
| RabbitMQ | Sí, por consumidores | Más workers = más throughput, sin reconfigurar |

**Aprovechamiento clave de costo:** los picos **están en el calendario**. La final de la Copa Intersemestral tiene fecha y hora conocidas, así que usamos **escalado programado** (pre-warm 30 min antes, con la BD ya escalada y los pools calientes) en lugar de pagar capacidad permanente o depender de un autoescalado reactivo que llegaría tarde a un pico de 30 segundos.

### 7.3 Cómo no se pierde ninguna operación

1. **Nada se responde "aceptada" antes del `COMMIT`.** La fuente de verdad de una apuesta es la transacción confirmada en PostgreSQL con `synchronous_commit=on` y réplica síncrona Multi-AZ. Si el proceso muere entre el commit y la respuesta, el cliente reintenta con la misma clave de idempotencia y recibe la apuesta ya registrada.
2. **No encolamos antes de validar.** Encolar la apuesta y validarla después permitiría "aceptar" apuestas que luego se rechazan, violando el SLA de respuesta y la regla de cierre. El SLA de 1 s alcanza de sobra para una transacción local de ~5 ms.
3. **Los eventos salen por outbox**, así que una caída de Kafka no pierde ni un evento ni frena una apuesta.
4. **Rechazo explícito con presión controlada**: si la BD se acerca a saturación, aplicamos *load shedding* devuelto al cliente como `503 + Retry-After` (rechazar rápido y decirle al cliente que reintente es honesto y recuperable); nunca colas internas ilimitadas que generan timeouts en cascada.
5. **Backpressure en el borde**: rate limiting por usuario (p. ej. 5 apuestas/s por usuario) y **sala de espera** para la final: el acceso al endpoint de apuestas se admite por *tokens* del gateway. Protege la BD de 100.000 clientes reintentando a la vez.

### 7.4 Garantizar que ninguna apuesta se acepte después del cierre

Tres barreras, de la más barata a la más autoritativa:

1. **Borde (optimización):** el gateway conoce `cierra_en` y rechaza con `410 CERRADA` sin tocar el core. Ahorra tráfico, pero **no es autoritativo** (su reloj puede desviarse).
2. **Servicio (defensa):** el core descarta peticiones cuya validación de proyección indique carrera cerrada.
3. **Base de datos (autoritativo):** la comparación decisiva es `now() >= cierra_en` evaluada **dentro de la transacción, con el reloj del servidor de base de datos**. Esto da una **única fuente de tiempo** para todo el sistema y elimina los desvíos de reloj entre decenas de pods. Todos los servidores sincronizan por NTP, pero la decisión la toma siempre el mismo reloj.

Consecuencias explícitas: una apuesta enviada a las 20:14:59.900 que llega al core a las 20:15:00.050 **se rechaza**, tal como exige el enunciado ("una apuesta que llegue después del cierre debe rechazarse, aunque el usuario la haya enviado antes"). `cierra_en` es **inmutable** desde la apertura, por lo que la proyección local puede estar desactualizada sin riesgo: lo único que podría cambiar es una cancelación, y una cancelación no tramitada solo provocaría aceptar apuestas que luego se devuelven al 100 % — un resultado reparable y conforme a las reglas del negocio.

### 7.5 Cómo no queda saldo negativo con apuestas en paralelo

- **Un solo mecanismo, y es la base de datos:** `UPDATE billetera SET saldo = saldo - :monto WHERE usuario_id = :u AND saldo >= :monto`. El bloqueo de fila serializa; `0 filas afectadas` = rechazo por saldo insuficiente.
- **No usamos** caché de saldo para decidir (Redis solo informa en pantalla), **no usamos** `SELECT` + `INSERT` en pasos separados, y **no usamos** reserva eventual.
- Aislamiento `READ COMMITTED` es suficiente gracias al `UPDATE` condicional (no hace falta `SERIALIZABLE`, que reduciría el throughput).
- **Verificación independiente:** el invariante `saldo = SUM(movimientos)` y `saldo >= 0` se audita continuamente con un job de conciliación que alerta ante la primera divergencia.

### 7.6 Presupuesto de latencia de una apuesta (SLA <1 s)

| Tramo | Presupuesto |
|---|---|
| Red cliente → borde (móvil) | 150–300 ms |
| Gateway: TLS + JWT + rate limit | 5 ms |
| Gateway → core (gRPC, misma VPC) | 2 ms |
| Core: validaciones locales + transacción (5 sentencias) | 10–25 ms |
| Respuesta de vuelta | 150–300 ms |
| **Total p99 estimado** | **≈ 350–650 ms** ✅ |

El margen restante es el que absorbe el pico: incluso con la base de datos a 5× la latencia normal, seguimos dentro de 1 s.

---

## 8. Decisión 8 — Manejo de fallos

### 8.1 Caso A — El sistema de notificaciones está caído

**¿Los usuarios deberían poder seguir apostando? → SÍ, absolutamente, y el diseño lo garantiza por construcción.**

- Notificaciones **no aparece en ningún punto del camino crítico**: no es invocado de forma síncrona por nadie. Es un **consumidor** de eventos de Kafka y un productor de comandos en RabbitMQ.
- Mientras está caído, los eventos (`ApuestaAceptada`, `ResultadoPublicado`, `MovimientoBilleteraRegistrado`) **se acumulan en Kafka** con su retención de 7 días. Al volver, el servicio reanuda desde su último offset confirmado y drena el backlog.
- Para evitar una avalancha de mensajes viejos e irrelevantes al recuperarse, las notificaciones llevan **relevancia temporal**: al drenar, se descartan los avisos de "comenzó la carrera" de carreras ya finalizadas (regla por tipo), pero **nunca** los de dinero ("recibiste EIA Coins"), que siempre se entregan.
- Degradación visible al usuario: no recibe el push, pero ve la apuesta y el saldo correctos en la app (el estado real vive en el core). La notificación es un **conveniencia**, no la fuente de verdad.
- Si el que falla es el **proveedor externo** (SMTP/FCM), la cola de RabbitMQ reintenta con backoff y deriva a DLQ tras 5 intentos, con alerta. Un canal caído no afecta a los otros porque hay **una cola por canal**.

### 8.2 Caso B — El servicio de billetera está caído

**¿Los usuarios deberían poder seguir apostando? → NO. Se debe rechazar la apuesta (fail-closed).**

Y aquí está la diferencia de fondo con el Caso A:

| | Notificaciones | Billetera |
|---|---|---|
| ¿Es fuente de verdad? | No. Es un efecto colateral informativo | **Sí. Es el libro mayor del dinero** |
| ¿Qué se rompe si sigo adelante sin él? | El usuario se entera más tarde | Se acepta una apuesta **sin respaldo de fondos**: doble gasto, saldo negativo, premios pagados con dinero que no existía |
| ¿Es reparable después? | Sí, trivialmente: se reenvía el mensaje | **No sin dañar a alguien**: habría que anular apuestas ya confirmadas y mostradas al usuario, o pagar premios sobre apuestas inválidas. Y si la carrera ya corrió, es imposible: la información es irreversible |
| ¿Cuál es el costo de decir "no"? | Inaceptable (el usuario pierde la oportunidad de apostar por algo irrelevante) | Aceptable: "intenta de nuevo en un momento". Molesto pero honesto y recuperable |

**La regla general que aplicamos:** *se puede degradar lo que informa; no se puede degradar lo que decide sobre el dinero.* Aceptar una apuesta sin poder debitarla crearía una obligación de pago sin respaldo, que es exactamente el tipo de error que **no** se puede compensar después.

**Cómo lo refuerza nuestra arquitectura:** como Billetera **vive dentro de `core-apuestas`**, "billetera caída" no es un modo de fallo parcial: o el core está arriba (y el débito funciona) o está abajo (y no se aceptan apuestas). **Eliminamos por diseño el estado peligroso** "apuestas disponibles pero billetera no", que es justamente el estado que obligaría a una decisión imposible. Esta es una de las razones más fuertes de la Decisión 1.

**Alternativa considerada y descartada:** aceptar la apuesta y debitar después de forma asíncrona ("apostar a crédito"). Se descarta porque permite gasto por encima del saldo con solo enviar apuestas en paralelo mientras la billetera está degradada, y porque obligaría a anular apuestas ya confirmadas al usuario. El requisito "nunca debe ser posible gastar dos veces los mismos EIA Coins" es un invariante duro, no un objetivo de mejor esfuerzo.

**Qué sí hacemos para maximizar disponibilidad del core** (en lugar de degradarlo):
- PostgreSQL Multi-AZ con failover automático (~30–60 s) y réplicas de lectura.
- Pods del core en ≥3 zonas de disponibilidad, despliegues *rolling* con *readiness probes*.
- Si cae el primario durante el pico: el gateway devuelve `503 + Retry-After: 2` y los clientes reintentan con la **misma clave de idempotencia**; al volver el servicio, los reintentos se aceptan sin duplicar. Si el failover supera la hora de cierre, el operador puede **posponer el cierre** (acción administrativa auditada) para no perjudicar a los apostadores.

### 8.3 Otros modos de fallo (completitud del análisis)

| Falla | ¿Se puede apostar? | Comportamiento |
|---|---|---|
| **Kafka caído** | **Sí** | Las apuestas se registran y los eventos quedan en el outbox. Degradación: cuotas estimadas congeladas, notificaciones y estadísticas retrasadas, auditoría retrasada (pero no perdida: el outbox es durable y el orden se conserva) |
| **RabbitMQ caído** | **Sí** | No se pueden lanzar lotes de liquidación nuevos ni enviar notificaciones. La liquidación se reanuda al volver; el SLA de 15 min se incumple con alerta explícita, pero nada se pierde porque los lotes pendientes están en la tabla `liquidacion_lote` y se re-publican |
| **`competencia` caído** | **Sí, para carreras ya abiertas** | El core usa su proyección local (que incluye el `cierra_en` inmutable). No se pueden abrir/cerrar/cancelar carreras ni publicar resultados hasta que vuelva |
| **`identidad` caído** | **Sí, con sesión vigente** | El JWT se valida localmente con JWKS en caché. No hay logins ni registros nuevos. Esto convierte un fallo total en una degradación parcial |
| **Redis caído** | **Sí** | Caché y rate limiting degradados (fallback a límites conservadores en memoria por instancia). Nada autoritativo vive en Redis |
| **`auditoria` caído** | **Sí** | Los eventos esperan en Kafka. Si la indisponibilidad excediera la retención, el volcado continuo a object storage preserva el registro. **Regla:** la auditoría nunca bloquea una operación, pero su backlog es una **alerta de severidad alta** |
| **Zona de disponibilidad caída** | Sí | Todo el camino crítico está replicado en ≥3 AZ |

### 8.4 Caso C — El resultado oficial estaba equivocado y ya se pagaron premios

Situación: 10 minutos después de `ResultadoPublicado`, el operador descubre que la foto de llegada se interpretó mal. Parte de los premios ya se acreditó.

**Principio: nada se borra, nada se sobrescribe. Se corrige hacia adelante (`forward correction`) con trazabilidad total.**

1. **Autorización reforzada.** Corregir un resultado es la operación más sensible del sistema: exige rol `operador` **más** aprobación de un `administrador` distinto (**doble control**), MFA, y queda registrada con ambos actores. No existe ninguna API que permita editar el resultado sin dejar rastro.
2. **El resultado es versionado, no mutable.** `competencia` inserta una **nueva versión** del resultado (`version_resultado = 2`) y publica `ResultadoCorregido` (E8) con ganador anterior, ganador nuevo, motivo, operador y aprobador. La versión 1 permanece en la base de datos y en el registro de auditoría para siempre.
3. **La liquidación se recalcula como v2, no se edita la v1.** El worker:
   - calcula la liquidación correcta (misma bolsa, misma comisión del 10 %, nuevo conjunto ganador y nuevo factor de pago) y emite `LiquidacionCalculada(v2)`;
   - genera **asientos de reversión** por cada premio pagado en v1 (`tipo=AJUSTE_REVERSION`, `operacion_id='reversion:premio:{apuestaId}:v1'`) — el movimiento original **no se elimina**: el libro mayor queda con el crédito y su reversión, que es la forma contable correcta;
   - acredita los premios de v2 (`operacion_id='premio:{apuestaId}:v2'`), idempotentes por construcción.
4. **Saldos que ya se gastaron.** Como los EIA Coins no son canjeables ni retirables, un usuario que recibió un premio indebido y lo volvió a apostar puede quedar con **saldo negativo controlado** (`saldo < 0`, marcado como deuda): se le impide apostar hasta regularizar y se le notifica con el detalle. *(Supuesto de negocio que declaramos explícitamente; la alternativa —que la casa absorba la diferencia— es una decisión de negocio de Dyllan, y el diseño soporta ambas con solo cambiar la política del asiento de ajuste.)*
5. **Notificación obligatoria y honesta.** `ResultadoCorregido` dispara avisos a todos los afectados: a quien perdió el premio y a quien lo gana ahora, con el motivo.
6. **Reconstrucción auditable.** Para cualquier carrera, el auditor puede reproducir: resultado v1 → liquidación v1 (bolsa, comisión, factor) → movimientos pagados → corrección v2 (quién y por qué) → reversiones → liquidación v2 → movimientos finales. Esto satisface literalmente el requisito "reconstruir, para cualquier carrera, cómo se calcularon sus premios".
7. **Ventana de seguridad (mitigación preventiva).** Para reducir la probabilidad del caso: la publicación del resultado tiene una **ventana de confirmación de 2 minutos** antes de disparar la liquidación (configurable por tipo de carrera). Cuesta 2 minutos del SLA de 15 y evita la gran mayoría de las correcciones post-pago. Es una decisión de negocio, pero la dejamos como opción de diseño activada por defecto.

---

## 9. Decisión 9 — Datos y consistencia

### 9.1 Base de datos por servicio

**Regla: ningún servicio lee la base de datos de otro.** Las lecturas cruzadas se resuelven con API síncrona o con proyecciones alimentadas por eventos.

| Servicio | Motor | Por qué ese motor | ¿Compartida? |
|---|---|---|---|
| **core-apuestas** | **PostgreSQL** (instancia dedicada, Multi-AZ, réplicas de lectura, PgBouncer) | Necesita transacciones ACID, restricciones UNIQUE como garantía de idempotencia, bloqueos de fila para el saldo y particionado por carrera. Es **el único requisito realmente duro de la plataforma** y es exactamente lo que un relacional hace mejor | **No.** Instancia dedicada: no comparte recursos con nadie, porque es quien sufre el pico |
| **competencia** | PostgreSQL (BD lógica propia) | Modelo relacional pequeño con máquina de estados y relaciones carrera↔mediano | Comparte **instancia física** con `identidad` y `notificaciones` en fase 1 (ver §11), con **BD, esquema y credenciales separadas** y sin consultas cruzadas. Se extrae a instancia propia cuando su carga lo justifique |
| **identidad** | PostgreSQL (BD lógica propia) + Redis (sesiones/revocación) | Datos sensibles: hashes Argon2id, cifrado en reposo con KMS, acceso muy restringido | Instancia compartida en fase 1, **esquema y credenciales aisladas**; candidata preferente a separación por motivos de seguridad |
| **notificaciones** | PostgreSQL pequeña (plantillas, preferencias, bitácora de envíos) + Redis (dedupe) | Volumen bajo, sin requisitos especiales | Instancia compartida en fase 1 |
| **analitica-fraude** | **Data lake** (object storage, Parquet, particionado por fecha/carrera) + **OLAP columnar** (ClickHouse / BigQuery) | Millones de registros/día, consultas analíticas y agregaciones; un OLTP sería ineficiente y caro para esto | No |
| **auditoria** | **Object storage WORM** (S3 Object Lock, retención ≥5 años) como almacén autoritativo + índice de consulta (PostgreSQL/ClickHouse, solo lectura para el auditor) | "Registro inalterable" exige un almacén que **técnicamente** impida la modificación, no solo que la prohíba por permisos. WORM + cadena de hashes da inmutabilidad verificable a costo de almacenamiento frío | No |
| **Kafka** | — | Es además el **almacén del histórico de eventos** a corto plazo (7 días) y la fuente de la que se alimentan data lake y auditoría | — |

### 9.2 Qué requiere consistencia fuerte y qué puede ser eventual

| Dato | Consistencia | Por qué |
|---|---|---|
| **Saldo de la billetera y sus movimientos** | **Fuerte** (serializable por fila) | Doble gasto y saldo negativo son inaceptables |
| **Aceptación/rechazo de una apuesta** | **Fuerte** | Es una decisión con efecto monetario inmediato y una respuesta vinculante al usuario |
| **Cierre de apuestas (`cierra_en` vs. `now()`)** | **Fuerte** (reloj único: el de la BD) | Regla de negocio explícita y auditable |
| **Cálculo de la liquidación (bolsa, comisión, factor)** | **Fuerte** | Debe ser reproducible al céntimo y auditable |
| **Estado de la carrera (máquina de estados)** | **Fuerte dentro de `competencia`** | Las transiciones son condicionadas y únicas |
| Proyección `carrera_apostable` en el core | **Eventual (acotada, segundos)** — pero **segura** | `cierra_en` y participantes son inmutables desde la apertura, así que el retraso no puede producir una decisión incorrecta sobre el cierre. Y ante duda, *fail-closed* vía S6 |
| Usuarios bloqueados (proyección en el core) | Eventual (segundos) | Un bloqueo que tarda 2 s en propagarse es aceptable; además el token tiene TTL corto y el gateway puede revocar al instante vía Redis |
| **Cuotas estimadas** | **Eventual (1–2 s)** | El negocio las define como "aproximadas" y cambiantes |
| Estadísticas y rendimiento histórico de medianos | Eventual (minutos) | Supuesto del enunciado |
| Reportes premium | Eventual (hasta 1 día) | Supuesto del enunciado |
| Registro de auditoría | Eventual en **latencia**, estricto en **completitud** | Puede llegar segundos después, pero no puede faltar ni alterarse |
| Notificaciones | Eventual | No es fuente de verdad |

### 9.3 Coherencia entre la apuesta y el descuento en la billetera

**La respuesta corta: no están en componentes distintos, precisamente para que este problema no exista.**

Apuesta, movimiento del libro mayor y evento de salida se escriben en **una sola transacción ACID local** (§6.2). No hay ventana de inconsistencia, no hay estado intermedio, no hay compensación que pueda fallar. **No usamos saga en el camino crítico porque no la necesitamos**, y el enunciado pide usar esos patrones *solo si realmente se requieren*.

Los únicos patrones distribuidos que sí usamos, y por qué:

| Patrón | Dónde | Por qué es necesario |
|---|---|---|
| **Transactional outbox** | `core-apuestas` y `competencia`, al publicar eventos | Sin él, el sistema podría comprometer la apuesta y perder el evento (o publicar un evento de una transacción que luego hizo rollback). Es el mínimo imprescindible para "pérdida cero de eventos" |
| **Inbox / deduplicación de eventos** | Todos los consumidores | Los brokers entregan *al menos una vez* |
| **Liquidación por lotes idempotentes** (saga simplificada con compensación explícita) | Pago de premios y correcciones (caso C) | Aquí sí hay un proceso de larga duración (minutos) que debe ser reanudable y compensable. Pero **cada paso es una transacción local**, así que no requiere coordinación distribuida |
| **Saga con reserva de fondos** | ❌ **No se usa** | Solo sería necesaria si Billetera estuviera en otro servicio. Queda documentada como camino de evolución a escala 100× (§13) |

### 9.4 Dónde vive el histórico de eventos y los datos de analítica

```
Servicios ──(outbox)──> Kafka (retención 7 días, el "bus" y la memoria corta)
                          │
         ┌────────────────┼─────────────────┬──────────────────────┐
         ▼                ▼                 ▼                      ▼
   Data lake         OLAP columnar     Auditoría WORM        Consumidores
  (S3/Parquet,       (ClickHouse/      (S3 Object Lock,      operativos
  crudo, barato)     BigQuery,         cadena de hashes,     (notificaciones,
  particionado       agregados y       ≥5 años, inmutable)   cuotas, core)
  por fecha/carrera  reportes premium)
```

- **Kafka** es la columna vertebral y el histórico de **corto plazo** (replay operativo de días).
- **Data lake** es el histórico **completo y crudo** de todos los eventos (fuente para reprocesar cuando cambien las reglas analíticas, sin tocar los servicios).
- **OLAP** guarda los agregados que responden las consultas premium en segundos.
- **Auditoría** es un almacén **separado y de otra naturaleza**: inmutable por configuración del almacenamiento (no por permisos de aplicación), con **cadena de hashes** (cada registro incluye el hash del anterior, de modo que cualquier alteración o eliminación es detectable) y retención legal de 5 años. Ciclo de vida: 90 días en acceso estándar → archivo frío los años restantes.
- **Política de retención en el OLTP:** las apuestas y movimientos de los últimos 90 días viven en PostgreSQL; las particiones más antiguas se desprenden y archivan en el lake. Así el camino crítico opera siempre sobre una base de datos pequeña y rápida, mientras el histórico completo sigue consultable.

### 9.5 Modelo de datos del núcleo (insumo para el diagrama de datos)

```
billetera(usuario_id PK, saldo, version, actualizada_en)
movimiento(id PK, usuario_id FK, tipo, monto, saldo_resultante, operacion_id,
           carrera_id?, apuesta_id?, registrado_en)        UNIQUE(usuario_id, operacion_id)
apuesta(id PK, usuario_id, carrera_id, mediano_id, monto, estado,
        idempotency_key, creada_en)                        UNIQUE(usuario_id, idempotency_key)
                                                           PARTITION BY carrera_id
carrera_apostable(carrera_id PK, estado, cierra_en, participantes[], version_evento)  -- proyección
usuario_bloqueado(usuario_id PK, desde)                    -- proyección
liquidacion(carrera_id, version_resultado, bolsa_total, comision, monto_distribuible,
            monto_apostado_ganador, factor_pago, estado)   UNIQUE(carrera_id, version_resultado)
liquidacion_lote(carrera_id, version_resultado, lote_nro, estado, rango)
                                                           UNIQUE(carrera_id, version_resultado, lote_nro)
operacion_idempotente(usuario_id, idempotency_key, estado, respuesta_json, expira_en)
outbox(evento_id PK, tipo, clave_particion, payload, publicado_en?)
evento_procesado(consumer_group, evento_id)                PK(consumer_group, evento_id)
```

**Fórmula pari-mutuel (determinista y auditable):**
`bolsaTotal = Σ montos de la carrera` · `comision = 0,10 × bolsaTotal` · `distribuible = bolsaTotal − comision` · `factorPago = distribuible / Σ montos de las apuestas ganadoras` · `premio_i = truncar(monto_i × factorPago)`.
Todo se calcula en **enteros (unidades mínimas de EIA Coin)**, nunca en punto flotante. El residuo de redondeo (siempre < número de ganadores) se asigna a la comisión de la casa, y queda registrado en `LiquidacionCalculada` para que el auditor cierre las cuentas al céntimo.
**Supuesto declarado:** si nadie apostó al mediano ganador, no hay conjunto ganador; se devuelve el 100 % de lo apostado (`tipo=DEVOLUCION`) y no se cobra comisión. (El enunciado no define este caso; lo fijamos explícitamente porque afecta a la fórmula.)

---

## 10. Seguridad

### 10.1 Componentes públicos vs. privados

| Zona | Componentes | Exposición |
|---|---|---|
| **Internet (público)** | CDN + WAF, **API Gateway**, **WS/Push Gateway**, endpoints de login/registro de `identidad` *expuestos a través del gateway* | Únicos puntos alcanzables desde Internet. Solo HTTPS/WSS, TLS 1.3, HSTS |
| **Red privada — capa de servicios** | `identidad`, `competencia`, `core-apuestas` (api), `notificaciones`, `analitica-fraude`, `auditoria` | Sin IP pública. Solo alcanzables desde el gateway, por mTLS, con política de red explícita (allowlist origen→destino) |
| **Red privada — capa de datos y mensajería** | PostgreSQL, Redis, Kafka, RabbitMQ, object storage, OLAP | Subredes aisladas, sin ruta a Internet (solo endpoints privados). Accesibles únicamente desde los servicios que las necesitan |
| **Red privada — trabajo asíncrono** | `worker-liquidacion`, workers de notificación, ETL | Sin exposición de entrada; solo consumen de brokers |
| **Acceso administrativo** | Panel de operador/administrador, API de auditoría | **No expuesto al público general**: red privada accesible por VPN / acceso de confianza cero, con MFA obligatorio y allowlist de IP. El rol auditor solo tiene permisos de lectura |

### 10.2 Autenticación y autorización

- **OAuth 2.0 / OpenID Connect** con `identidad` como emisor. **Access token JWT de vida corta (5–15 min)** firmado con RS256/EdDSA + **refresh token rotatorio** de un solo uso (detecta robo por reutilización).
- **Validación local del JWT** en el gateway con JWKS en caché: sin llamadas por petición, y `identidad` deja de ser un punto único de fallo para las sesiones vigentes.
- **Revocación inmediata** (bloqueo de usuario, cierre de sesión) mediante lista de revocación en Redis consultada por el gateway — compensa el TTL del token.
- **MFA obligatorio** para `operador`, `administrador` y `auditor`.
- **RBAC en dos niveles**: el gateway valida el rol de forma gruesa (bloquea un apostador que llama a `/admin/*`); cada servicio valida de forma fina **y sobre el objeto** (un apostador solo consulta *sus* apuestas y *su* billetera — prevención de IDOR/BOLA). Nunca se confía en un `usuarioId` enviado por el cliente: se toma del token.
- Matriz de permisos: `apostador` (apostar, consultar lo propio) · `operador` (ciclo de vida de carreras, publicar resultado) · `administrador` (usuarios, roles, bloqueos, aprobar correcciones) · `auditor` (**solo lectura** del registro inalterable; sin acceso a datos personales más allá de lo necesario).
- **Separación de poderes:** quien publica un resultado no puede aprobar su corrección; quien administra usuarios no puede alterar el registro de auditoría (que es técnicamente inmutable para todos).

### 10.3 Protección de APIs, bots y abuso

- **Rate limiting por capas:** por IP en WAF/CDN, por usuario y por endpoint en el gateway (p. ej. 5 apuestas/s por usuario, 5 intentos de login/min), y cuota global de admisión al endpoint de apuestas durante la final (**sala de espera**).
- **WAF** (OWASP Top 10), protección DDoS gestionada, validación estricta de esquemas de entrada, límites de tamaño de payload, paginación obligatoria.
- **Anti-bot:** CAPTCHA en registro y tras fallos de login, *device fingerprint* enviado en la apuesta (insumo del módulo de fraude), detección de múltiples cuentas por dispositivo y de ráfagas en los segundos previos al cierre — ambos escenarios citados por el enunciado — con acción automática de bloqueo preventivo revisable por un administrador.
- **CORS** restrictivo, cabeceras de seguridad, sin secretos ni datos personales en URLs o query strings (la `Idempotency-Key` va en cabecera, nunca en la URL).

### 10.4 Cifrado y manejo de credenciales

- **En tránsito:** TLS 1.3 público; **mTLS** entre servicios en la red privada; TLS también hacia Kafka, RabbitMQ, Redis y PostgreSQL.
- **En reposo:** cifrado de volúmenes y backups con KMS; cifrado **a nivel de campo** para datos personales sensibles; los movimientos de billetera se consideran datos sensibles y su acceso queda registrado.
- **Contraseñas:** Argon2id (o bcrypt con coste alto) + sal por usuario; nunca reversibles, nunca en logs.
- **Secretos:** Secrets Manager / Vault con rotación automática; inyección en tiempo de ejecución; **cero secretos en código, repositorios o imágenes**; identidades de servicio de corta duración (roles IAM / cuentas de servicio) en lugar de credenciales estáticas.
- **Logs:** redacción automática de tokens, contraseñas y datos personales; retención y acceso controlados.

### 10.5 Registro de acciones administrativas

- **Toda** acción de `operador` y `administrador` (crear/abrir/cancelar carrera, publicar o corregir resultado, bloquear usuario, cambiar rol, ajustar saldo) genera un evento firmado hacia `auditoria`, con actor, rol, IP, marca de tiempo, valores anteriores y nuevos, y motivo obligatorio en texto libre.
- Operaciones de máximo riesgo (corrección de resultado, ajuste manual de saldo) exigen **doble control**: ejecutor + aprobador distintos.
- El registro es **inmutable para todos**, incluidos los administradores (S3 Object Lock + cadena de hashes). Nadie en la empresa puede borrar su propio rastro — eso es lo que convierte la auditoría en una garantía real y no en una promesa.

---

## 11. Costos

> *"No quiero pagar una infraestructura de Netflix para una carrera de cinco medianos."*

### 11.1 Decisiones de costo tomadas

| Decisión | Ahorro / razón |
|---|---|
| **6 servicios, no 20** | Cada servicio extra cuesta CI/CD, observabilidad, cómputo base, una BD y carga cognitiva. Fusionamos Medianos en Competencia, Premios en el Core, y Fraude en Analítica, porque el costo de separarlos no compraba ningún beneficio real |
| **Una sola instancia física de PostgreSQL compartida** por `identidad`, `competencia` y `notificaciones` (BD, esquemas y credenciales separadas; sin consultas cruzadas) | Tres instancias Multi-AZ pequeñas cuestan ~3× una mediana. La frontera lógica se mantiene intacta, así que separarlas luego es una migración de datos, no un rediseño |
| **Instancia dedicada solo para `core`** | Es el único componente que sufre el pico. Aislarlo evita que una consulta de reportes degrade el camino crítico |
| **Escalado programado aprovechando el calendario de carreras** | Los picos no son sorpresa: se pre-escala 30 min antes de la final y se reduce después. Pagamos el pico 2 horas al mes, no 720. Es, de lejos, la decisión de costo con mayor impacto |
| **Workers de liquidación de 0 a N, en spot/serverless** | Trabajan ~10 minutos tras cada carrera. Pagar instancias permanentes para eso sería absurdo |
| **Servicios administrados** (PostgreSQL, Kafka, RabbitMQ, Redis, object storage, OLAP) sobre contenedores gestionados (ECS Fargate / Cloud Run) | **Sin Kubernetes propio ni clusters autogestionados en fase 1**: el costo real de esta plataforma sería el personal de operación, no las máquinas |
| **Un cluster de Kafka (3 brokers) y uno de RabbitMQ**, no uno por servicio | Evita literalmente el escenario que el enunciado ridiculiza |
| **Almacenamiento por niveles** | OLTP solo 90 días (particiones antiguas desprendidas) → Parquet en object storage → archivo frío tras 1 año. Guardar 5 años de auditoría en PostgreSQL costaría órdenes de magnitud más que en almacenamiento WORM frío |
| **CDN + WebSocket push en vez de polling** | 100.000 usuarios refrescando cuotas cada 2 s serían 50.000 req/s inútiles. El push convierte eso en un cálculo y un fan-out |
| **No mantener contadores transaccionales de la bolsa** | Además de eliminar el cuello de botella, evita tener que sobredimensionar la base de datos para absorber contención artificial |
| **Sin multi-región, sin service mesh, sin 3 entornos idénticos en fase 1** | Multi-región duplica el costo para un negocio de una sola universidad. Se incorpora solo si el negocio lo exige (ver §13) |

### 11.2 Orden de magnitud (fase 1, cloud público)

| Partida | Estimación mensual |
|---|---|
| PostgreSQL `core` Multi-AZ (mediana) + 1 réplica | $300–500 |
| PostgreSQL compartida (pequeña Multi-AZ) | $120–200 |
| Cómputo de servicios (base, fuera del pico) | $250–450 |
| Kafka gestionado (3 brokers pequeños) | $300–500 |
| RabbitMQ gestionado (pequeño, HA) | $80–150 |
| Redis gestionado | $60–120 |
| Object storage + OLAP (uso moderado) | $100–250 |
| CDN/WAF, observabilidad, secretos | $150–300 |
| **Base mensual** | **≈ $1.400–2.500** |
| **Sobrecosto por evento final** (pre-escalado de 2–3 h: cómputo ×5 + BD mayor) | **+ $50–150 por evento** |

El mensaje para Dyllan: **la infraestructura base cuesta como un empleado de medio tiempo, y el pico de la final cuesta menos que la salchipapa de la celebración**. Si el negocio arrancara aún más pequeño, la variante de mínimo costo es: sustituir RabbitMQ por una cola gestionada trivial y arrancar con Kafka de una sola zona (aceptando menor durabilidad), bajando la base a ~$700/mes sin cambiar ni una línea del diseño lógico.

---

## 12. ADR — Registros de las tres decisiones más importantes

### ADR-001 — Arquitectura híbrida: núcleo transaccional modular + servicios satélite

**Estado:** Aceptada · **Fecha:** 2026-10-19 · **Decide:** equipo de arquitectura

**Contexto.** La plataforma debe aceptar 10.000 apuestas/s durante 30 s con respuesta en menos de 1 s, no perder ninguna apuesta ni movimiento de billetera, impedir el doble gasto, liquidar más de un millón de apuestas en 15 minutos, soportar analítica de millones de registros diarios, conservar auditoría 5 años, y todo ello con un presupuesto modesto y un equipo pequeño. Los requisitos de consistencia (dinero) y los de escala/desacoplamiento (notificaciones, analítica, auditoría) apuntan en direcciones opuestas.

**Opciones consideradas.**
1. **Monolito único** (todo en un despliegue y una BD): simple y barato, pero acopla fallos y escalado — una caída de notificaciones o un lote de liquidación tumbaría o degradaría las apuestas, y escalar el pico obligaría a replicar todo el sistema.
2. **Microservicios finos** (≈10 servicios, uno por capacidad): máxima independencia, pero obliga a una saga con reserva de fondos en el camino crítico, suma saltos de red al presupuesto de 1 s, multiplica los modos de fallo y el costo fijo de operación. El enunciado penaliza explícitamente el sobrediseño.
3. **Serverless orientado a eventos** ("encolar y validar después"): incompatible con responder *aceptada/rechazada* en <1 s y con la regla de cierre exacto.
4. **Híbrida** (elegida): monolito modular para el dominio del dinero + microservicios para lo desacoplable.

**Decisión.** Un núcleo `core-apuestas` (Apuestas + Billetera + Liquidación, un artefacto con perfiles `api` y `worker`, una base de datos PostgreSQL) y cinco satélites independientes (`identidad`, `competencia`, `notificaciones`, `analitica-fraude`, `auditoria`) detrás de un API Gateway, comunicados por eventos.

**Consecuencias.**
*Se gana:* consistencia fuerte del dinero sin transacciones distribuidas; latencia predecible (una transacción local en el camino crítico); escalado independiente justo donde hace falta; aislamiento de fallos de notificaciones/analítica/auditoría; 6 unidades operables por un equipo pequeño; costo bajo.
*Se sacrifica:* el núcleo es un dominio de fallo común — si cae, no hay apuestas (mitigado con Multi-AZ, multi-zona e idempotencia en los reintentos); su base de datos es el único componente del camino crítico que escala verticalmente (mitigado con réplicas, particionado y la hoja de ruta de §13); y exige **disciplina de equipo** para que las fronteras internas entre módulos no se degraden (se protege con esquemas separados por módulo y prohibición de dependencias cruzadas verificada en CI).

---

### ADR-002 — Apuesta y débito de billetera en una única transacción local (en lugar de saga)

**Estado:** Aceptada · **Fecha:** 2026-10-19

**Contexto.** Antes de aceptar una apuesta hay que validar existencia del usuario, carrera abierta antes del cierre, participación del mediano, saldo suficiente y no duplicidad; y hay que debitar los EIA Coins. El requisito es categórico: *nunca* debe ser posible gastar dos veces los mismos coins, y *ninguna* apuesta aceptada puede perderse. Además hay que responder en <1 s con 10.000 peticiones/s, y los clientes reintentan (el caso de los cuatro clics).

**Opciones consideradas.**
1. **Saga con reserva de fondos** (servicios separados): `reservar → crear apuesta → confirmar/liberar`. Introduce estados intermedios, fondos congelados ante compensaciones perdidas, dos saltos de red por apuesta y un proceso de reconciliación permanente.
2. **Débito asíncrono optimista** ("apostar a crédito", debitar después): la más rápida, pero permite gasto por encima del saldo enviando apuestas en paralelo, y obliga a anular apuestas ya confirmadas al usuario. Viola el invariante central.
3. **Event sourcing puro de la billetera** con proyección de saldo: excelente auditabilidad, pero el saldo proyectado es eventual, así que la validación de fondos necesitaría de todos modos un mecanismo de consistencia fuerte sobre el flujo. Complejidad alta para el mismo resultado.
4. **Transacción local única** (elegida): mismo servicio, misma base de datos, un `BEGIN…COMMIT`.

**Decisión.** Apuesta, asiento del libro mayor, actualización de saldo y fila del outbox se escriben en **una sola transacción ACID**. El doble gasto lo impide un `UPDATE … WHERE saldo >= monto` condicional (bloqueo de fila); el duplicado lo impide `UNIQUE (usuario_id, idempotency_key)`; la publicación del evento sin pérdida la garantiza el outbox.

**Consecuencias.**
*Se gana:* imposibilidad estructural de doble gasto y saldo negativo; ninguna ventana de inconsistencia entre apuesta y saldo; cero código de compensación en el camino crítico; latencia de ~10–25 ms; y la respuesta al Caso B deja de ser un dilema (no existe el estado "apuestas sí, billetera no").
*Se sacrifica:* Apuestas y Billetera no pueden escalar ni desplegarse por separado, y comparten su destino en caso de fallo; la base de datos del núcleo concentra la carga de escritura; y las apuestas simultáneas de un mismo usuario se serializan en su fila de billetera (efecto deseado, pero es un límite por usuario). Si el volumen creciera 100×, la extracción de Billetera con saga de reserva está documentada como paso de evolución, con el costo que hoy evitamos pagar por adelantado.

---

### ADR-003 — Kafka para eventos de dominio y RabbitMQ para colas de trabajo

**Estado:** Aceptada · **Fecha:** 2026-10-19

**Contexto.** Hay dos necesidades de mensajería muy distintas. (a) Hechos del negocio que interesan simultáneamente a analítica, fraude, auditoría y notificaciones, con volumen de 10.000/s, necesidad de historial y de reproducir eventos, y agregación en streaming para las cuotas estimadas. (b) Trabajo a ejecutar: millones de pagos troceados en lotes que deben repartirse entre workers, y envíos a proveedores externos que fallan y deben reintentarse con backoff sin bloquear a los demás.

**Opciones consideradas.**
1. **Solo Kafka**: obligaría a reimplementar reintentos escalonados con *retry topics*, sufriría *head-of-line blocking* con mensajes envenenados en notificaciones, y limitaría el paralelismo de los workers de liquidación al número de particiones.
2. **Solo RabbitMQ**: sin replay (se pierde la capacidad de reconstruir auditoría o recalcular estadísticas), fan-out multi-consumidor caro en copias y memoria, y sin stream processing para las cuotas.
3. **Ninguno** (llamadas síncronas): rompe el requisito de que notificaciones no bloquee una apuesta y hace imposible liquidar un millón de apuestas.
4. **Ambos, con frontera estricta** (elegida).

**Decisión.** **Kafka** (1 cluster gestionado, 3 brokers) transporta **eventos en pasado**: `ApuestaAceptada`, `ResultadoPublicado`, `MovimientoBilleteraRegistrado`, eventos de carrera, cuotas. **RabbitMQ** (1 cluster gestionado pequeño) transporta **comandos en imperativo**: `LiquidarLote`, `EnviarNotificacion`, `RecalcularEstadisticas`. Regla única para el equipo: *hecho releíble por varios → Kafka; tarea ejecutable y reintentable → RabbitMQ.*

**Consecuencias.**
*Se gana:* la herramienta correcta para cada patrón; replay y retención para auditoría y analítica; DLQ y backoff por mensaje sin bloquear colas; paralelismo de workers desacoplado de las particiones; y un desacoplamiento real que sostiene las respuestas a los casos de fallo.
*Se sacrifica:* dos tecnologías de mensajería que aprender, monitorizar y pagar (~$400–650/mes combinados). Se mitiga con servicios administrados, un único cluster de cada uno, una librería interna que oculta los detalles (sobre, outbox, inbox) y una regla mental inequívoca. Plan de contingencia explícito: si el costo o la complejidad se vuelven un problema, se elimina RabbitMQ (sustituible por una cola gestionada simple) y se conserva Kafka, que es el irreemplazable.

*(Candidatos a cuarto ADR, documentados en las decisiones 6 y 7: estrategia de idempotencia basada en restricciones únicas de base de datos, y eliminación del contador transaccional de la bolsa en favor de la agregación por streaming.)*

---

## 13. Pregunta final — ¿Qué implementaríamos hoy y cómo evolucionaría a 100×?

### 13.1 Hoy

Implementaríamos exactamente la arquitectura de este documento: **un núcleo transaccional modular con el dinero adentro, cinco satélites desacoplados por eventos, Kafka como backbone de hechos y RabbitMQ para el trabajo, todo sobre servicios administrados y con escalado programado al calendario de carreras.**

El razonamiento, dimensión por dimensión:

| Dimensión | Por qué esta arquitectura hoy |
|---|---|
| **Complejidad** | La mínima que resuelve el problema: 6 servicios. Sin sagas, sin event sourcing, sin mesh, sin multi-región. Cada pieza de complejidad que incluimos (outbox, inbox, dos brokers, liquidación por lotes) resuelve un requisito explícito del enunciado y se puede señalar con el dedo |
| **Escalabilidad** | Lo que debe escalar escala horizontalmente (gateway, core-api, ws, workers, consumidores). Lo que no lo necesita (competencia, auditoría) no paga por ello. El pico está en el calendario, así que lo absorbemos con escalado programado y no con capacidad permanente |
| **Resiliencia** | Fallos aislados por diseño: notificaciones, analítica, auditoría, Kafka y hasta identidad pueden caer y la gente sigue apostando. Lo único que no se degrada es el dinero, y eso es deliberado |
| **Consistencia** | Fuerte donde está el dinero (una transacción local), eventual donde el negocio lo permite (cuotas, estadísticas, notificaciones). El límite entre ambas es una frontera de despliegue, no una convención |
| **Seguridad** | Superficie pública mínima (gateway + push), todo lo demás en red privada con mTLS; JWT corto + refresh rotatorio; MFA y doble control en operaciones sensibles; auditoría técnicamente inmutable que ni los administradores pueden alterar |
| **Costo** | ~$1.400–2.500/mes de base y ~$100 extra por evento masivo. Sin clusters autogestionados, sin personal de plataforma, con almacenamiento por niveles |
| **Mantenibilidad** | Un artefacto donde está lo difícil (el dominio del dinero, con sus invariantes testeables en una sola base de datos) y servicios pequeños donde está lo independiente. Las fronteras internas del núcleo son módulos reales, verificados en CI: eso es lo que hace posible extraerlos después |

### 13.2 Evolución a 100× — hoja de ruta con disparadores medibles

Lo importante no es la lista de pasos, sino que **ninguno exige rediseñar**: cada uno es una extracción a lo largo de una frontera que ya existe.

| Etapa | Disparador (métrica concreta) | Movimiento | Qué lo hace posible desde hoy |
|---|---|---|---|
| **1. Ajuste vertical y lecturas** | p99 de apuesta > 400 ms, o CPU del primario > 60 % en pico | Instancia mayor, más réplicas de lectura, más particiones en `apuestas.aceptadas` (24 → 96), caché más agresiva | Lecturas y escrituras ya están separadas; el particionado por carrera ya existe |
| **2. Separar el perfil worker** | La liquidación compite por conexiones con el camino crítico | Los workers pasan a su propia instancia/pool y leen de una réplica para calcular, escribiendo solo los asientos en el primario | Mismo artefacto, ya desplegado con perfiles distintos |
| **3. Extraer Liquidación como servicio** | > 5.000.000 de apuestas por carrera, o el SLA de 15 min en riesgo | Servicio propio que acredita vía **API de billetera idempotente** (`operacion_id` ya es la clave) | Los pagos ya son idempotentes por `operacion_id`; nada cambia en el contrato |
| **4. CQRS y proyecciones de lectura** | Las consultas de "mis apuestas"/"movimientos" dominan la carga | Proyecciones materializadas en un almacén de lectura alimentadas por `ApuestaAceptada` y `MovimientoBilleteraRegistrado` | Esos eventos ya existen, con clave de partición por usuario y orden garantizado |
| **5. Extraer Billetera con saga de reserva** | > 50.000 apuestas/s sostenidas, o necesidad de equipos independientes | Billetera como servicio; la apuesta pasa a `reservar → crear → confirmar`, con compensación por timeout | Es el paso que **hoy evitamos deliberadamente** (ADR-002). El libro mayor ya es append-only con claves de operación, así que la reserva es un tipo de asiento más |
| **6. Particionar (sharding) el dinero** | El primario de `core` deja de escalar verticalmente | Sharding de billeteras por `usuario_id` y de apuestas por `carrera_id` (ya es la clave de partición). Una carrera vive en pocos shards; un usuario, en uno | El `usuario_id` ya es la clave de partición de los movimientos y el `carrera_id` la de las apuestas: el sharding sigue fronteras existentes |
| **7. Multi-región** | Audiencia fuera de la región, o exigencia de RTO/RPO regional | Activo-pasivo con réplica asíncrona (el dinero no tolera escrituras multi-maestro), lecturas y push servidos globalmente | El dominio ya está dividido entre lo que exige consistencia fuerte y lo que tolera réplica eventual |
| **8. Plataforma de datos** | Reportes premium como línea de negocio real | Lakehouse con capas crudo/curado/servido, *feature store* para modelos de fraude y cuotas | El data lake ya recibe todos los eventos crudos desde el día uno: **se puede reprocesar la historia completa con reglas nuevas** |

**El principio de evolución:** el diseño de hoy no es "la arquitectura pequeña que habrá que botar", sino **la arquitectura grande con las extracciones aún no ejecutadas**. Las tres cosas que hacen posible crecer 100× sin reescribir están desde el primer día: (1) **eventos de dominio con claves de partición bien elegidas** (`carreraId`, `usuarioId`), que son las mismas claves de un futuro sharding; (2) **toda operación de dinero identificada por una `operacion_id` idempotente**, lo que permite mover el pago detrás de una API de red sin cambiar su semántica; y (3) **módulos con fronteras verificadas en CI**, de modo que extraer un módulo es empaquetarlo, no reescribirlo.

### 13.3 Anticipación del cambio de requisitos de la sustentación: apuestas en vivo durante la carrera

El enunciado advierte que en la sustentación se planteará un cambio de requisitos, y menciona como ejemplo **permitir apuestas mientras la carrera está en curso**. Cómo lo absorbe este diseño:

| Qué cambia | Impacto | Por qué es barato |
|---|---|---|
| El cierre deja de ser un instante único | `carrera_apostable` pasa de `cierra_en` único a **mercados** con ventanas propias: `mercado(carrera_id, tipo, abre_en, cierra_en, estado)`. La validación sigue siendo `now() < cierra_en` sobre el reloj de la BD | La regla autoritativa de cierre ya vive en un solo lugar y ya es una comparación por fila |
| La bolsa se cierra por mercado, no por carrera | `liquidacion` pasa a tener clave `(carrera_id, mercado_id, version_resultado)`; la fórmula pari-mutuel no cambia | La liquidación ya es por lotes idempotentes y versionada |
| Las cuotas deben actualizarse en segundos | Ventana de agregación de Kafka Streams de 1 s → 250 ms y push por WebSocket | El cálculo de cuotas ya está **fuera** de la base de datos; subir su frecuencia solo cuesta cómputo de stream |
| El operador emite eventos durante la carrera (vueltas, posiciones) | Nuevos eventos `VueltaRegistrada`, `MercadoAbierto`, `MercadoCerrado` en `competencia.carreras`, con la misma clave de partición | Los consumidores existentes los ignoran; añadir un evento no rompe a nadie (esquemas versionados y compatibles hacia adelante) |
| El riesgo de fraude aumenta (apostar sabiendo el resultado) | Nueva regla en el módulo de fraude + **suspensión automática del mercado** ante eventos de carrera relevantes, y retardo de aceptación configurable | El módulo de fraude ya consume `ApuestaAceptada` y `ApuestaRechazada` en tiempo casi real |
| Más apuestas por usuario y por carrera | Más escrituras, misma estructura | El particionado por carrera y la ausencia de contadores calientes ya absorben el crecimiento |

**Nada de esto toca el núcleo monetario**: la apuesta en vivo sigue siendo una transacción local con débito condicional e idempotencia por clave. El cambio es de *modelo de dominio* (de "carrera apostable" a "mercados apostables"), no de arquitectura — que es la señal de que las fronteras se trazaron en el lugar correcto.

---

## 14. Anexo A — Insumos listos para los diagramas

### A.1 Diagrama general: nodos y aristas

**Nodos — zona pública:** `Cliente Web`, `App Móvil`, `CDN + WAF`, `API Gateway`, `WS/Push Gateway`
**Nodos — zona privada de servicios:** `identidad`, `competencia`, `core-apuestas (api)`, `core-apuestas (worker-liquidacion)`, `notificaciones`, `analitica-fraude`, `auditoria`, `stream-cuotas (Kafka Streams)`
**Nodos — zona privada de datos:** `PG core (primario + réplica)`, `PG compartida (identidad | competencia | notificaciones)`, `Redis`, `Kafka`, `RabbitMQ`, `Data Lake (S3/Parquet)`, `OLAP`, `Auditoría WORM (S3 Object Lock)`
**Nodos externos:** `SMTP`, `FCM/APNs`

**Aristas síncronas (línea continua, con flecha):** S1…S11 de la tabla §3.2.
**Aristas asíncronas (línea discontinua):**
`core-apuestas → Kafka`: E10, E11, E14 · `competencia → Kafka`: E3–E9 · `identidad → Kafka`: E1, E2 · `worker-liquidacion → Kafka`: E13, E15 · `stream-cuotas ⇄ Kafka`: consume E10, produce E12
`Kafka → notificaciones` (E1,E3,E4,E6,E7,E8,E9,E14) · `Kafka → analitica-fraude` (todos) · `Kafka → auditoria` (todos) · `Kafka → core-apuestas` (E1,E2,E4,E5,E7,E8,E9) · `Kafka → ws-gateway` (E5,E6,E12) · `Kafka → Data Lake` (volcado continuo)
`core-apuestas → RabbitMQ`: C1 · `RabbitMQ → worker-liquidacion`: C1 · `notificaciones → RabbitMQ → workers de canal`: C2 · `analitica → RabbitMQ`: C3

**Leyenda obligatoria:** ── síncrono (REST/gRPC) · ╌╌ asíncrono (evento Kafka) · ┄┄ asíncrono (comando RabbitMQ) · 🔒 frontera público/privado.

### A.2 Diagrama de secuencia "Apostar" — pasos numerados

1. `Usuario` pulsa **APOSTAR** → la app usa la `Idempotency-Key` generada al abrir el formulario.
2. `App` → `API Gateway`: `POST /apuestas {carreraId, medianoId, monto}` + `Authorization: Bearer <JWT>` + `Idempotency-Key`.
3. `Gateway`: valida JWT con JWKS en caché (sin llamar a `identidad`), aplica rate limit por usuario, verifica que la carrera no esté marcada como cerrada en caché (rechazo temprano opcional).
4. `Gateway` → `core-apuestas (api)`: gRPC `CrearApuesta`.
5. `core`: busca `operacion_idempotente(usuario, clave)`. **Si existe y está completa → devuelve la respuesta original (paso 12).**
6. `core`: `BEGIN`.
7. `core`: lee `carrera_apostable` → valida `estado='ABIERTA'`, `now() < cierra_en` (**reloj de la BD**), `medianoId ∈ participantes`. *(Si la carrera no está en la proyección → S6 gRPC a `competencia`; si falla → rechazo *fail-closed*.)*
8. `core`: `UPDATE billetera SET saldo = saldo - monto WHERE usuario_id=? AND saldo >= monto` → 0 filas ⇒ `SALDO_INSUFICIENTE` + `ROLLBACK`.
9. `core`: `INSERT apuesta` (UNIQUE idempotencia) + `INSERT movimiento` (`DEBITO_APUESTA`, UNIQUE `operacion_id`).
10. `core`: `INSERT outbox` (`ApuestaAceptada`, `MovimientoBilleteraRegistrado`).
11. `core`: `COMMIT` ✅ *(a partir de aquí la apuesta existe; antes, no)*.
12. `core` → `Gateway` → `App`: `201 {apuestaId, saldoRestante, aceptadaEn}` — **p99 ≈ 350–650 ms**.
13. *(Asíncrono, fuera del camino crítico)* `relay de outbox` → `Kafka`: `ApuestaAceptada` (part. `carreraId`), `MovimientoBilleteraRegistrado` (part. `usuarioId`).
14. `Kafka` → `notificaciones` → `RabbitMQ` → push "apuesta aceptada".
15. `Kafka` → `stream-cuotas` → `CuotasEstimadasActualizadas` → `ws-gateway` → clientes.
16. `Kafka` → `analitica-fraude` (patrones) y `auditoria` (registro inalterable).

**Flujo alternativo que conviene dibujar:** los clics 2, 3 y 4 del usuario repiten los pasos 2–5 y terminan en el paso 5 devolviendo **la misma apuesta**, sin débito adicional. *(Este es el flujo que el enunciado considera el corazón del ejercicio.)*

### A.3 Diagrama de mensajería — Kafka

| Topic | Particiones | Clave | RF | Retención | Consumer groups |
|---|---|---|---|---|---|
| `apuestas.aceptadas` | 24 | `carreraId` | 3 | 7 días | `cg-analitica`, `cg-auditoria`, `cg-cuotas`, `cg-notificaciones` |
| `apuestas.rechazadas` | 6 | `carreraId` | 3 | 7 días | `cg-analitica`, `cg-auditoria` |
| `billetera.movimientos` | 24 | `usuarioId` | 3 | 7 días | `cg-auditoria`, `cg-analitica`, `cg-notificaciones` |
| `competencia.carreras` | 6 | `carreraId` | 3 | 7 días | `cg-core`, `cg-notificaciones`, `cg-analitica`, `cg-auditoria`, `cg-ws` |
| `competencia.resultados` | 6 | `carreraId` | 3 | 30 días | `cg-liquidacion`, `cg-notificaciones`, `cg-auditoria`, `cg-analitica` |
| `liquidacion.eventos` | 6 | `carreraId` | 3 | 30 días | `cg-auditoria`, `cg-analitica`, `cg-competencia` |
| `cuotas.estimadas` | 6 | `carreraId` | 3 | **compactado** | `cg-ws`, `cg-gateway` |
| `identidad.usuarios` | 3 | `usuarioId` | 3 | 7 días | `cg-core`, `cg-notificaciones`, `cg-auditoria` |

Productores: `acks=all`, `enable.idempotence=true`, `min.insync.replicas=2`, compresión `lz4`.
Consumidores: `auto.commit=false` (commit después de procesar), deduplicación por `eventoId`, `max.poll.records` ajustado por servicio.

### A.4 Diagrama de mensajería — RabbitMQ

```
                    exchange "liquidacion" (direct)
core (coordinador) ────rk: liquidacion.lote────► q.liquidacion.lotes ──► worker-liquidacion ×N
                                                      │ (nack / 5 intentos)
                                                      ▼
                                              q.liquidacion.lotes.dlq ──► alerta

                    exchange "notificaciones" (topic)
notificaciones ──rk: notif.email.*──► q.notif.email ──► worker-email ──► SMTP
               ──rk: notif.push.*───► q.notif.push  ──► worker-push  ──► FCM/APNs
               ──rk: notif.inapp.*──► q.notif.inapp ──► worker-inapp
                                           │ fallo
                                           ▼
                              q.notif.retry (TTL 5s/30s/5m) ──► vuelve al exchange
                                           │ 5º fallo
                                           ▼
                                      q.notif.dlq ──► alerta
```
Colas `durable`, mensajes `persistent`, `publisher confirms`, `ack` manual, `prefetch=10` en workers de liquidación, `x-dead-letter-exchange` en todas.

### A.5 Diagrama de estados de la carrera (con eventos emitidos)

```
PROGRAMADA ──(abrir)──► ABIERTA ──(now() >= cierra_en)──► CERRADA ──(largada)──► EN_CURSO
    │E3                    │E4                              │E5                     │E6
    │                      │                                │                       │
    └──────────────────────┴────────────────────────────────┴───────────────────────┤
                       (cancelar, E9 → devolución 100 %)                            │
                                                                                     ▼
                                          LIQUIDADA ◄──(E15)── FINALIZADA (resultado oficial, E7)
                                             ▲                      │
                                             └──(E8 ResultadoCorregido → liquidación v2)
```

---

## 15. Anexo B — Trazabilidad con el enunciado

| Requisito del enunciado | Dónde se resuelve |
|---|---|
| Decisión 1 — estilo + 2 alternativas descartadas | §1 (3 alternativas descartadas) + ADR-001 |
| Decisión 2 — división de servicios | §2 (6 servicios + decisiones de agrupación justificadas) |
| Decisión 3 — tabla de comunicación síncrona + timeouts | §3.2, §3.3 |
| Decisión 4 — eventos, idioma único, tabla, payload mínimo | §4 (idioma español, fusiones justificadas, sobre común) |
| Decisión 5 — RabbitMQ vs. Kafka | §5 + ADR-003 |
| Decisión 6 — idempotencia (≥3 operaciones) | §6 (6 operaciones + tabla de restricciones únicas) |
| Decisión 7 — 10.000 apuestas/s | §7 (8 cuellos de botella, escalado, cierre exacto, saldo no negativo) |
| Decisión 8 — fallos A, B y C | §8.1, §8.2, §8.4 (+ §8.3 adicional) |
| Decisión 9 — datos y consistencia | §9 |
| Seguridad + público/privado | §10 |
| Costos | §11 |
| 3 ADR de máx. 1 página | §12 |
| Pregunta final (hoy + 100×) | §13.1, §13.2 |
| Cambio de requisitos en vivo (sustentación) | §13.3 |
| Insumos para diagramas (general, secuencia, mensajería) | Anexo A |
| "Ningún mediano recibe dos premios por cuatro clics" | §6.2 Operación 1 y 3; Anexo A.2 flujo alternativo |

---

## 16. Conclusiones

1. **El problema no es de escala, es de consistencia.** 10.000 apuestas/s es exigente pero resoluble con herramientas conocidas; lo verdaderamente difícil es que ningún EIA Coin se gaste dos veces y que ninguna apuesta aceptada se pierda. Por eso la arquitectura se organiza alrededor del dinero, no alrededor del tráfico.
2. **La decisión más valiosa fue la que evitó complejidad, no la que la agregó.** Mantener Apuestas y Billetera en una transacción local eliminó de un golpe las sagas, los estados intermedios, los fondos congelados y la mitad de los modos de fallo del sistema.
3. **La idempotencia no es una característica, es una propiedad transversal.** Está en la clave del cliente, en las restricciones únicas de la base de datos, en el `operacion_id` de cada asiento, en los lotes de liquidación y en el consumo de eventos. Es lo que convierte "el usuario presionó cuatro veces" en un no-evento.
4. **El desacoplamiento se aplica donde compra disponibilidad, no por moda.** Notificaciones, analítica y auditoría están separadas porque su caída no debe afectar a nadie. Medianos, Resultados y Premios no están separados porque hacerlo solo habría comprado latencia y factura.
5. **Los picos predecibles son un regalo de este dominio.** Como el calendario de carreras se conoce de antemano, la plataforma absorbe 100.000 usuarios con escalado programado en lugar de capacidad permanente: ahí está la diferencia entre $2.000 y $20.000 al mes.
6. **Corregir hacia adelante preserva la confianza.** Resultados versionados, asientos de reversión y un registro técnicamente inmutable permiten admitir un error humano sin destruir la trazabilidad — y la trazabilidad es el único activo que una casa de apuestas no puede perder.
7. **Esta arquitectura está diseñada para ser extraída, no reescrita.** Las claves de partición de hoy son las claves de sharding de mañana; los módulos de hoy son los servicios de mañana. Crecer 100× es ejecutar extracciones pendientes a lo largo de fronteras que ya existen.
8. **Complejidad justa:** 6 servicios, 2 brokers gestionados, 3 bases de datos operativas, 1 data lake, 0 clusters autogestionados. Suficiente para 100.000 usuarios y para cinco medianos. Dyllan conserva su negocio y el equipo conserva su empleo.

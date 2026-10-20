# Propuesta de arquitectura — La Gran Liga de Apuestas de Medianos EIA

**Cliente:** Salchipapa Maker Racing S.A.S.
**Qué es este documento:** nuestra propuesta de diseño. Responde una por una las preguntas del enunciado: las nueve decisiones obligatorias, seguridad, costos, los tres ADR y la pregunta final.
**Qué no es:** una implementación. No construimos el sistema; explicamos qué haríamos y por qué.
**Base:** [`enunciado/contexto-proyecto.md`](../enunciado/contexto-proyecto.md), que recoge el enunciado completo.

**Cómo leer cada sección:** primero **la propuesta** en una o dos frases, después **por qué** la elegimos y **qué se gana y qué se pierde**.

---

## 0. La propuesta en pocas palabras

1. **Un servicio central guarda la apuesta y los EIA Coins juntos**, en la misma base de datos. Así, cuando alguien apuesta, se guarda la apuesta y se descuenta el saldo **en un solo paso**: o quedan las dos cosas, o no queda ninguna.
2. **Alrededor hay cinco servicios separados**: Usuarios, Carreras, Notificaciones, Estadísticas y Auditoría. Están aparte porque si alguno se cae, la gente debe poder seguir apostando.
3. **Un solo API Gateway** por donde pasan todas las peticiones de la app.
4. **Lo que el usuario espera en pantalla se hace de forma síncrona** (él pregunta, el sistema responde). **Todo lo demás se hace con eventos**: el servicio avisa "esto pasó" y sigue trabajando.
5. **Kafka para los hechos** que le interesan a varios servicios y que queremos poder volver a leer. **RabbitMQ para las tareas** que alguien debe ejecutar y que pueden fallar y reintentarse.
6. **Seis servicios, no veinte.** Cada pieza que agregamos resuelve un requisito concreto del enunciado; lo demás lo dejamos afuera a propósito.

### Los nombres que usamos

| Nombre | De qué se encarga |
|---|---|
| **API Gateway** | Único punto por donde entra todo. Verifica el **JWT** del usuario —el token de sesión firmado que dice quién es y con qué rol— y limita cuántas peticiones puede hacer |
| **Apuestas** ⭐ | Recibe las apuestas, guarda los EIA Coins de cada usuario y paga los premios |
| **Usuarios** | Registro, inicio de sesión, roles y bloqueos |
| **Carreras** | Carreras, medianos participantes y resultados oficiales |
| **Notificaciones** | Avisos por correo, push y dentro de la app |
| **Estadísticas** | Datos históricos, reportes que Dyllan quiere vender, cuotas estimadas y detección de fraude |
| **Auditoría** | Historial que no se puede modificar ni borrar, para que el auditor pueda revisar cualquier carrera |

⭐ Es el único servicio donde está el dinero. Por eso recibe la atención especial de todo el diseño.

---

## 1. Decisión 1 — ¿Monolito, microservicios o algo intermedio?

### Propuesta

**Arquitectura híbrida.** Una sola aplicación para todo lo que toca el dinero (apuestas, billetera y pago de premios), y servicios independientes para lo demás.

La parte del dinero es un **monolito modular**: una sola aplicación, con una sola base de datos, pero dividida por dentro en partes bien separadas (apuestas, billetera, premios), cada una con su propia responsabilidad. Los otros cinco son **microservicios**: cada uno se despliega, se actualiza y crece por su cuenta, con su propia base de datos.

### Por qué

1. **El problema más difícil del enunciado no es el tráfico, es el dinero.** "Nunca se pueden gastar dos veces los mismos EIA Coins" y "ninguna apuesta aceptada puede perderse" son reglas que no admiten excepciones. Si la apuesta y el saldo están en la misma base de datos, guardar las dos cosas a la vez es una operación normal de base de datos. Si están en servicios distintos, hay que reconstruir esa garantía con mecanismos mucho más frágiles.
2. **El tráfico es alto pero conocido.** 10.000 apuestas por segundo durante 30 segundos son unas 300.000 apuestas. Eso lo aguanta una base de datos relacional bien dimensionada. No necesitamos partir el dominio en pedazos para soportar la carga.
3. **Lo que sí conviene separar es lo que no toca el dinero.** El enunciado lo pide explícitamente: si las notificaciones se caen, la gente debe poder seguir apostando. Lo mismo vale para las estadísticas (millones de registros al día, pueden ir con minutos de retraso) y la auditoría (se guarda cinco años y casi nunca se consulta).
4. **Seis servicios los puede mantener un equipo pequeño.** Quince, no.

### Alternativas descartadas

**A — Un solo monolito con todo adentro (incluidas notificaciones, estadísticas y auditoría).**
Lo descartamos porque junta en una sola aplicación cosas que deben fallar y crecer por separado. Una caída o una actualización del módulo de notificaciones tumbaría las apuestas, justo lo que el enunciado prohíbe. El pago de más de un millón de premios competiría por la misma máquina que debe responder en menos de un segundo. Y para aguantar el pico de la final habría que agrandar *todo* el sistema, no solo la parte que recibe apuestas.

**B — Un microservicio por cada capacidad (usuarios, medianos, carreras, apuestas, billetera, resultados, premios, notificaciones, estadísticas, auditoría: diez o más).**
Lo descartamos porque separar Billetera de Apuestas obliga a coordinar dos servicios en cada apuesta: primero reservar el saldo, después crear la apuesta y al final confirmar o devolver la reserva. Eso agrega pasos por la red (tiempo que le quitamos al segundo de respuesta), estados intermedios y un proceso extra para arreglar las reservas que quedaron a medias. Y no gana nada en disponibilidad: si Billetera está caída, igual no se puede aceptar la apuesta. Además, Medianos o Resultados como servicios propios tendrían muy poco tráfico y el mismo costo fijo de mantenimiento que uno grande. El enunciado penaliza el sobrediseño.

**C — Recibir la apuesta en una cola y validarla después.**
Lo descartamos porque el enunciado exige que el usuario sepa en **menos de un segundo si su apuesta fue aceptada o rechazada**. No se puede responder "aceptada" antes de haber comprobado el saldo, el cierre y si la apuesta está repetida. Sí usamos colas, pero para lo que viene **después** de aceptar la apuesta: pagar premios, notificar, calcular estadísticas.

---

## 2. Decisión 2 — Cómo dividimos los servicios

### Propuesta

Seis servicios y un API Gateway.

| Servicio | Qué contiene | Base de datos | Cómo crece |
|---|---|---|---|
| **API Gateway** | Verifica el JWT del usuario, limita peticiones, reparte el tráfico | No guarda datos | Se agregan copias según el tráfico |
| **Apuestas** ⭐ | Apuestas, billetera de EIA Coins, cálculo y pago de premios | Relacional propia (por ejemplo PostgreSQL) | Muchas copias en el pico; el pago de premios corre aparte, después de la carrera |
| **Usuarios** | Registro, inicio de sesión, roles (apostador, operador, administrador, auditor), bloqueos | Relacional propia | Crece solo cuando todos entran al evento, no durante el pico de apuestas |
| **Carreras** | Carreras y su estado, medianos participantes, resultados oficiales y sus correcciones | Relacional propia | Casi no escribe; lo que crece son las consultas, y esas se responden con copias de lectura |
| **Notificaciones** | Plantillas, preferencias y envío por correo, push y app | Relacional pequeña | Crece con retraso aceptable: los avisos pueden salir unos minutos después |
| **Estadísticas** | Histórico, reportes premium, cuotas estimadas, reglas de fraude | Almacén de histórico + base de datos pensada para reportes | No necesita ir al día; trabaja a su ritmo |
| **Auditoría** | Registro que no se puede modificar ni borrar, y consulta para el rol auditor | Almacenamiento que no permite sobrescribir, con cinco años de retención | Escribe poco y constante; casi no se consulta |

### Decisiones de agrupación que el enunciado pide justificar

| Pregunta | Nuestra respuesta | Por qué |
|---|---|---|
| ¿**Medianos** merece un servicio propio? | **No.** Va dentro de Carreras | Son unas pocas decenas de registros que casi nunca cambian, y siempre se consultan junto con la carrera (quién participa, cuántas ganó). Un servicio aparte agregaría una llamada por la red y costo de mantenimiento para un dato que nunca cambia solo. Su historial estadístico vive en Estadísticas, que es quien realmente lo usa |
| ¿**Resultados** y **Premios** van aparte? | **No.** El resultado oficial va en Carreras; el pago de premios va en Apuestas | El resultado es un dato de la carrera, así que lo guarda quien administra la carrera. El pago de premios necesita leer **todas** las apuestas y escribir **en** la billetera: separarlo obligaría a mover millones de registros por la red |
| ¿**Billetera** aparte de **Apuestas**? | **No.** Es la decisión central (ver ADR-002) | Misma aplicación, misma base de datos, un solo paso: así no hay forma de gastar dos veces el mismo saldo ni de quedar en negativo |
| ¿**Fraude** aparte de **Estadísticas**? | **No.** Mismo servicio, partes distintas | Los dos leen exactamente los mismos eventos y necesitan el mismo histórico. Separarlos duplicaría el almacenamiento para guardar lo mismo |
| ¿**Auditoría** aparte de **Estadísticas**? | **Sí** | Necesitan cosas opuestas: la auditoría no puede cambiar nunca y se guarda cinco años; las estadísticas se recalculan y se reescriben todo el tiempo. Juntarlas pondría en riesgo el requisito de "registro inalterable" |
| ¿**Usuarios** aparte? | **Sí** | Guarda contraseñas y datos personales, así que conviene aislarlo. Y su carga no coincide con la de las apuestas: todos inician sesión al abrir el evento, no en el último segundo antes del cierre |
| ¿**Notificaciones** aparte? | **Sí** | Requisito explícito del enunciado: que se caiga no puede impedir registrar una apuesta |

### Otras piezas que aparecen en el diagrama

- **Filtro de tráfico en la entrada**: protege contra bots y guarda copias de las páginas y listados que todos consultan.
- **Kafka** y **RabbitMQ**, cada uno con un solo clúster, administrados por el proveedor de nube.
- **Memoria caché** compartida: para contar peticiones por usuario y guardar copias de listados. Nada importante vive solo ahí.
- **Almacenamiento de archivos** para el histórico y para la auditoría.

---

## 3. Decisión 3 — Comunicación síncrona

### Propuesta

**Síncrono solo cuando alguien está esperando la respuesta en pantalla.** Y, sobre todo: **aceptar una apuesta no necesita llamar a ningún otro servicio.**

Las cuatro validaciones que el enunciado exige antes de aceptar una apuesta se resuelven todas dentro de Apuestas, sin salir a la red:

| Validación exigida | Cómo la resolvemos sin llamar a nadie |
|---|---|
| Que el usuario exista y no esté bloqueado | El **JWT** que trae la petición —un token firmado por Usuarios— ya dice quién es y con qué rol. Además, Apuestas mantiene su propia lista de usuarios bloqueados, que se actualiza con los eventos que publica Usuarios |
| Que la carrera esté abierta y antes del cierre | Apuestas guarda su propia copia de las carreras abiertas, con la hora de cierre y los participantes. Esa copia la crea el evento `CarreraAbierta`. La hora de cierre **no cambia nunca** una vez abierta la carrera, así que la copia sigue siendo correcta aunque llegue con segundos de retraso |
| Que el mediano participe en la carrera | Misma copia local |
| Que el usuario tenga saldo suficiente | Está en su propia base de datos |
| Que la apuesta no esté repetida | Lo impide una restricción única en su propia base de datos (ver decisión 6) |

Esto es lo que hace posible responder en menos de un segundo con 10.000 apuestas por segundo: **una apuesta es una operación en una sola base de datos.**

### Tabla de comunicaciones síncronas

| # | Origen | Destino | Protocolo | Qué pide | Por qué debe ser síncrona | Si no responde a tiempo |
|---|---|---|---|---|---|---|
| S1 | App del usuario | API Gateway | REST sobre HTTPS | Todas las operaciones del usuario | El usuario está esperando en pantalla | La app reintenta **con la misma clave de la operación**, así que no se duplica nada |
| S2 | API Gateway | Usuarios | REST | Registro, inicio de sesión | Sin sesión no hay nada que hacer; la respuesta es la sesión | Un reintento y, si falla, se avisa "intenta más tarde". Las sesiones ya abiertas siguen funcionando |
| S3 | API Gateway | Usuarios | REST | Las claves públicas para verificar los JWT | Hacen falta para validar, pero se piden cada cierto tiempo y se guardan, no en cada petición | Se sigue usando la última copia guardada. Si Usuarios se cae, las sesiones vigentes no se interrumpen |
| S4 | API Gateway | Apuestas | gRPC | Crear apuesta, consultar saldo, ver mis apuestas y movimientos | El enunciado exige saber en menos de 1 segundo si la apuesta fue aceptada o rechazada, y el saldo tiene que ser el real | Se corta la espera y se responde "intenta de nuevo". **Nunca se responde "aceptada" si no quedó guardada.** La app reintenta con la misma clave |
| S5 | API Gateway | Carreras | REST | Lista de carreras, detalle, ficha de un mediano | Es una consulta que el usuario hace y espera | Un reintento y, si falla, se muestra la última copia guardada (unos segundos de atraso son aceptables aquí) |
| S6 | Apuestas | Carreras | gRPC **solo por excepción** | Datos de una carrera que no está en su copia local | Solo pasa si el servicio acaba de arrancar o si se perdió un evento. **No ocurre en el flujo normal** | Si no responde, **se rechaza la apuesta**. Preferimos rechazar una apuesta (el usuario reintenta) antes que aceptar una apuesta de una carrera que quizá ya cerró |
| S7 | Carreras | Apuestas | gRPC | Cuánto se ha apostado en total en una carrera, para el panel del operador | El operador necesita el número real en pantalla antes de dar la salida | Se muestra el último valor conocido, marcado como aproximado |
| S8 | API Gateway | Estadísticas | REST | Reportes premium, tendencias | Es una consulta de un cliente que paga por el reporte | Se entrega el reporte calculado del día anterior; el enunciado permite hasta un día de atraso |
| S9 | API Gateway | Auditoría | REST, solo lectura | Historial de una carrera, cómo se calcularon sus premios | El auditor está consultando | Si la consulta es muy grande, se entrega por partes o se deja preparada para descargar después |
| S10 | API Gateway | Usuarios / Carreras | REST, por red privada | Operaciones de administración: roles, bloqueos, crear o cancelar carrera, publicar resultado | Quien las ejecuta necesita confirmación inmediata | No se reintentan solas: el operador vuelve a enviarlas, y la clave de la operación evita que se apliquen dos veces |
| S11 | Notificaciones | Proveedor de correo y push | HTTPS | Entregar el mensaje | La API del proveedor funciona así | Se reintenta varias veces con esperas cada vez más largas, usando RabbitMQ. **Nunca afecta al que está apostando** |

### Qué hacemos cuando una llamada síncrona falla

- **Siempre fijamos un tiempo máximo de espera.** Nunca dejamos el valor por defecto.
- **Reintentamos solo las consultas** y las operaciones que se pueden repetir sin efecto. Las que mueven dinero las reintenta la app, con la misma clave de operación.
- **Dejamos de insistir con un servicio que está fallando** durante unos segundos, en vez de llenarlo de peticiones.
- **La regla final:** si lo que falla es una consulta informativa, mostramos datos un poco viejos; si lo que falla es algo que decide sobre dinero, **rechazamos**. Rechazar se puede corregir reintentando; aceptar mal, no.

---

## 4. Decisión 4 — Comunicación con eventos

### Propuesta

Todos los nombres **en español y en pasado**, porque un evento es algo que ya pasó: `ApuestaAceptada`, `CarreraCerrada`, `ResultadoPublicado`.

Los mensajes de RabbitMQ no son eventos sino **tareas**, así que se nombran como una orden, para no confundirlos: `LiquidarLote`, `EnviarNotificacion`.

### Qué hicimos con los eventos que sugiere el enunciado

| Evento sugerido | Nuestra decisión |
|---|---|
| `ApuestaRealizada` | Lo llamamos **`ApuestaAceptada`**, y solo lo publicamos cuando la apuesta quedó realmente guardada. "Realizada" es ambiguo: ¿intentada o aceptada? Agregamos `ApuestaRechazada`, porque el módulo de fraude necesita ver también los rechazos |
| `CarreraIniciada` | **Se queda igual** |
| `CarreraFinalizada` + `ResultadoPublicado` | **Los unimos en `ResultadoPublicado`.** En este negocio la carrera termina justamente cuando se registra el resultado oficial: dos eventos describirían el mismo hecho y obligarían a cada consumidor a esperar los dos |
| `PremioCalculado` | Lo cambiamos por **`LiquidacionCalculada`**, uno por carrera y no uno por apuesta. Un evento por apuesta serían más de un millón de eventos en una carrera para decir algo que se puede calcular. Este evento lleva la bolsa total, la comisión y **cuánto paga cada EIA Coin apostado**, que es exactamente lo que la auditoría necesita para reconstruir cualquier premio |
| `PremioPagado` | Lo absorbe **`MovimientoBilleteraRegistrado`**, con un campo que dice de qué tipo es el movimiento (descuento por apuesta, pago de premio o devolución). Tener tres eventos casi iguales duplicaría trabajo; mejor un solo flujo de movimientos y que cada consumidor filtre el tipo que le interesa |
| `CarreraCancelada` | **Se queda igual** |
| — | **Agregamos:** `CarreraProgramada`, `CarreraAbierta` (importante: es el que lleva la hora de cierre y los participantes a Apuestas), `CarreraCerrada`, `ResultadoCorregido`, `LiquidacionFinalizada`, `MovimientoBilleteraRegistrado`, `CuotasEstimadasActualizadas`, `UsuarioRegistrado` y `UsuarioEstadoCambiado` |

### Qué lleva todo evento

Siempre los mismos datos generales, más los datos propios del hecho:

- **identificador único del evento** — es lo que permite darse cuenta de que un evento llegó repetido;
- **tipo** (`ApuestaAceptada`, …) y **versión**, para poder cambiar el formato más adelante sin romper a nadie;
- **fecha y hora** en que ocurrió;
- **quién lo publicó**;
- **clave de reparto** (`carreraId` o `usuarioId`);
- **datos del negocio**.

### Tabla de eventos

Todos van por **Kafka**.

| # | Evento | Lo publica | Topic | Lo leen | Clave de reparto | Datos que lleva |
|---|---|---|---|---|---|---|
| E1 | `UsuarioRegistrado` | Usuarios | `usuarios.eventos` | Apuestas (le crea la billetera en cero), Notificaciones, Estadísticas | `usuarioId` | usuario, alias, fecha, medios de contacto |
| E2 | `UsuarioEstadoCambiado` | Usuarios | `usuarios.eventos` | Apuestas (lista de bloqueados), Auditoría, Notificaciones | `usuarioId` | usuario, estado anterior y nuevo, motivo, quién lo hizo |
| E3 | `CarreraProgramada` | Carreras | `carreras.eventos` | Notificaciones, Estadísticas, Auditoría | `carreraId` | carrera, hora de inicio, pista, distancia, participantes |
| E4 | **`CarreraAbierta`** | Carreras | `carreras.eventos` | **Apuestas (crea la copia de la carrera)**, Notificaciones, Estadísticas | `carreraId` | carrera, **hora de cierre**, participantes |
| E5 | `CarreraCerrada` | Carreras | `carreras.eventos` | Apuestas (deja de aceptar), app de los usuarios, Estadísticas, Auditoría | `carreraId` | carrera, hora de cierre real |
| E6 | `CarreraIniciada` | Carreras | `carreras.eventos` | Notificaciones, app de los usuarios, Estadísticas | `carreraId` | carrera, hora de inicio |
| E7 | **`ResultadoPublicado`** | Carreras | `carreras.resultados` | **Apuestas (dispara el pago de premios)**, Notificaciones, Estadísticas, Auditoría | `carreraId` | carrera, versión del resultado, ganador, orden de llegada, tiempos, operador |
| E8 | `ResultadoCorregido` | Carreras | `carreras.resultados` | Apuestas (recalcula los premios), Notificaciones, Auditoría, Estadísticas | `carreraId` | carrera, versión, ganador anterior y nuevo, motivo, quién corrigió y quién aprobó |
| E9 | `CarreraCancelada` | Carreras | `carreras.eventos` | Apuestas (devuelve el 100 %), Notificaciones, Auditoría, Estadísticas | `carreraId` | carrera, motivo, fecha, operador |
| E10 | **`ApuestaAceptada`** | Apuestas | `apuestas.aceptadas` | Estadísticas y fraude, Auditoría, cálculo de cuotas, Notificaciones | `carreraId` | apuesta, usuario, carrera, mediano, monto, fecha, clave de la operación |
| E11 | `ApuestaRechazada` | Apuestas | `apuestas.rechazadas` | Estadísticas y fraude, Auditoría | `carreraId` | usuario, carrera, mediano, monto, motivo del rechazo |
| E12 | `CuotasEstimadasActualizadas` | Proceso de cuotas | `cuotas.estimadas` | App de los usuarios, API Gateway, Estadísticas | `carreraId` | carrera, total apostado y cuota estimada por mediano |
| E13 | `LiquidacionCalculada` | Apuestas (pago de premios) | `premios.eventos` | **Auditoría**, Estadísticas | `carreraId` | carrera, versión del resultado, bolsa total, comisión del 10 %, monto a repartir, cuánto paga cada EIA Coin apostado, cuántas apuestas ganaron |
| E14 | **`MovimientoBilleteraRegistrado`** | Apuestas | `billetera.movimientos` | Auditoría, Estadísticas, Notificaciones | `usuarioId` | movimiento, usuario, tipo (descuento, premio, devolución o corrección), monto, saldo que quedó, operación que lo causó |
| E15 | `LiquidacionFinalizada` | Apuestas (pago de premios) | `premios.eventos` | Carreras (marca la carrera como liquidada), Notificaciones, Auditoría | `carreraId` | carrera, apuestas pagadas, monto total, cuánto tardó |

**Por qué esas claves de reparto:** la clave decide en qué partición cae el evento, y todos los eventos de una misma clave llegan **en orden** al consumidor. Con `carreraId` nos aseguramos de que "se abrió", "se cerró" y "se publicó el resultado" de una carrera lleguen en ese orden. Con `usuarioId` nos aseguramos de que los movimientos de una billetera no se desordenen.

### Tareas que van por RabbitMQ

| # | Tarea | La publica | Exchange | Routing key | Cola | La ejecuta | Por qué una cola y no un topic |
|---|---|---|---|---|---|---|---|
| C1 | `LiquidarLote` | Apuestas, al recibir el resultado oficial | `liquidacion` (direct) | `liquidacion.lote` | `q.liquidacion.lotes` | Varios procesos de pago en paralelo | Un millón de apuestas se parte en lotes y la cola los reparte sola entre los procesos que estén libres. Si uno se cae a mitad del lote, el lote vuelve a la cola |
| C2 | `EnviarNotificacion` | Notificaciones | `notificaciones` (topic) | `notif.email.*`, `notif.push.*`, `notif.inapp.*` | Una cola por canal | Un proceso por canal | Si un correo falla, se reintenta ese mensaje con esperas crecientes **sin frenar los demás**. Si un canal está caído, los otros siguen funcionando |
| C3 | `RecalcularEstadisticas` | Estadísticas | `estadisticas` (direct) | `estadisticas.recalculo` | `q.estadisticas.recalculo` | Procesos de cálculo | Es trabajo pesado por lotes, que se puede repetir y cancelar sin consecuencias |

### Cómo manejamos los errores al consumir

- **Todos los consumidores están preparados para recibir el mismo mensaje dos veces**, porque Kafka y RabbitMQ lo garantizan "al menos una vez" (ver decisión 6).
- **En Kafka**: cada evento se guarda en tres copias y el consumidor solo confirma su avance **después** de haber procesado. Si algo falla, vuelve a leer desde donde quedó. Los eventos se guardan una semana para poder releerlos, y además se copian al almacén de histórico.
- **En RabbitMQ**: las colas y los mensajes sobreviven a un reinicio del servidor, el mensaje se confirma solo cuando la tarea terminó bien, y después de varios intentos fallidos se aparta en una **cola de mensajes con problemas** que genera una alerta, en vez de bloquear a los demás.
- **Ningún evento se pierde al publicarlo.** Ningún servicio publica directo a Kafka: en la misma operación en que guarda la apuesta, guarda también el evento en una tabla de salida (**outbox**). Otro proceso lee esa tabla y publica. Si Kafka está caído, las apuestas siguen funcionando y los eventos salen cuando vuelva.

---

## 5. Decisión 5 — ¿RabbitMQ, Kafka, ambos o ninguno?

### Propuesta

**Los dos, con una frontera clara y una sola regla para el equipo:**

> ¿Es un **hecho** que le puede interesar a varios y que quiero poder volver a leer? → **Kafka.**
> ¿Es una **tarea** que alguien debe ejecutar, que puede fallar y hay que reintentar? → **RabbitMQ.**

| | **Kafka** | **RabbitMQ** |
|---|---|---|
| Qué lleva | Hechos del negocio | Tareas por hacer |
| Cómo funciona | Varios consumidores leen lo mismo, cada uno a su ritmo, y pueden volver atrás | Varios procesos se reparten las tareas; cada tarea la hace uno |
| Lo usamos para | `ApuestaAceptada`, `ResultadoPublicado`, `MovimientoBilleteraRegistrado`, eventos de carrera, cuotas | `LiquidarLote`, `EnviarNotificacion`, `RecalcularEstadisticas` |
| Cuánto montamos | Un solo clúster administrado | Un solo clúster administrado, pequeño |

### Por qué vale la pena mantener dos

**Si usáramos solo Kafka:**
- Reintentar un correo que falló habría que programarlo a mano, creando topics intermedios de espera. Sería reimplementar RabbitMQ.
- Un mensaje que no se puede procesar **frena a los que vienen detrás** en su partición: una notificación imposible de entregar detendría las notificaciones de muchos usuarios.
- El número de procesos de pago que pueden trabajar en paralelo quedaría limitado por el número de particiones. Con una cola, agregar procesos es inmediato.

**Si usáramos solo RabbitMQ:**
- **No se puede volver a leer** lo que ya se consumió. Perderíamos lo que el enunciado pide explícitamente: guardar el historial de eventos y poder reproducirlos para reconstruir la auditoría o recalcular estadísticas después de un error.
- Mandar el mismo hecho a cuatro consumidores significa cuatro copias del mensaje, y si uno está caído su cola crece sin control.
- Las cuotas estimadas se calculan sumando las apuestas que van llegando. Eso es natural leyendo el flujo de Kafka y ajeno a una cola de tareas.

### Cómo controlamos el costo de tener dos

1. **Los dos son administrados** por el proveedor de nube: no mantenemos servidores, ni actualizaciones, ni respaldos.
2. **Un solo clúster de cada uno**, no uno por servicio. Evitamos a propósito el escenario de "seis clústeres de Kafka y cuatro de RabbitMQ" que el enunciado ridiculiza.
3. **Una sola regla mental** (la de arriba) para que nadie dude dónde publicar.
4. **Plan B declarado:** si el costo molesta, quitamos RabbitMQ y usamos una cola simple del proveedor, o incluso una tabla de tareas en la base de datos. **Si tuviéramos que elegir uno solo, elegiríamos Kafka**, porque es el que no se puede reemplazar dados los requisitos de historial y de varios consumidores.

---

## 6. Decisión 6 — Idempotencia: "Dyllan no quiere pagar dos veces"

### Propuesta

**No confiamos en que nadie reintente.** El usuario va a presionar cuatro veces, la red va a duplicar peticiones y tanto Kafka como RabbitMQ entregan el mismo mensaje más de una vez. Por eso:

> Toda operación que mueve dinero tiene **un identificador único**, y la **base de datos** es la que garantiza que no se repita, con una **restricción única**.

Una copia en memoria caché puede ayudar a detectar el duplicado más rápido, pero la que decide siempre es la base de datos, en la misma operación que hace el cambio.

### Operación 1 — Crear una apuesta (el caso de los cuatro clics)

La app **genera la clave de la operación al abrir el formulario**, no al presionar el botón. Así, los cuatro clics envían **la misma clave**. Después, Apuestas hace todo esto en una sola operación de base de datos:

1. Mira su copia de la carrera: ¿está abierta?, ¿ya pasó la hora de cierre?, ¿el mediano participa? Si algo falla, rechaza.
2. Descuenta el saldo con una instrucción que **solo se aplica si el saldo alcanza**. Si no alcanza, no descuenta nada y rechaza.
3. Guarda la apuesta. Aquí actúa la **restricción única** sobre (usuario, clave de la operación): si la clave ya existía, la base de datos no deja insertar.
4. Guarda el movimiento en el historial de la billetera, también con su identificador único de operación.
5. Guarda los eventos en la tabla de salida (outbox).

Si la clave ya existía, en vez de responder un error **devolvemos la respuesta original**: el usuario ve su apuesta, una sola, con un solo descuento de 500 EIA Coins. Guardamos esa respuesta original en una tabla de operaciones ya atendidas, durante unos días.

La clave va **junto con el usuario**, para que nadie pueda adivinar la clave de otro y leer o estorbar sus operaciones.

### Operación 2 — Descontar los EIA Coins (que nadie gaste dos veces ni quede en negativo)

- El descuento **nunca** se hace en tres pasos (leer el saldo, decidir, escribir). Es una sola instrucción condicionada: "resta este monto **solo si el saldo alcanza**". La base de datos atiende de una en una las apuestas del mismo usuario, así que diez apuestas simultáneas con saldo para cinco dan exactamente cinco aceptadas y cinco rechazadas. **El saldo nunca queda negativo.**
- Cada movimiento tiene un identificador de operación que se **deduce del hecho que lo causó** (por ejemplo, "apuesta 1234"), no un número que va aumentando. Repetir la operación no puede crear un segundo movimiento.
- El saldo se guarda además del historial de movimientos, y un proceso revisa periódicamente que el saldo coincida con la suma de los movimientos. Si alguna vez no coincide, avisa.

### Operación 3 — Pagar un premio (que nadie reciba el premio dos veces)

- El identificador de operación del pago es "premio de la apuesta 1234, versión 1 del resultado". Si el proceso se cae justo después de acreditar y antes de confirmar, al reintentar la base de datos rechaza el movimiento repetido y **el premio no se paga dos veces**.
- El trabajo se parte en lotes, y cada lote tiene su propio identificador. Cada lote se paga en una sola operación de base de datos y queda marcado como hecho. Si RabbitMQ vuelve a entregar ese lote, el proceso ve que ya está hecho y lo confirma sin hacer nada.
- Las **devoluciones** por carrera cancelada usan exactamente el mismo mecanismo, con el identificador "devolución de la apuesta 1234".

### Operación 4 — Recibir el mismo evento dos veces

- Cada consumidor guarda los **identificadores de eventos que ya procesó**, y lo hace en la misma operación en que aplica el efecto. Si el identificador ya estaba, el evento ya se procesó: lo confirma y sigue.
- Donde se puede, evitamos incluso esa tabla: la copia de carreras de Apuestas se sobrescribe con el dato más nuevo y descarta los eventos viejos; Auditoría ignora el registro si ya tiene ese identificador de evento.

### Operación 5 — Publicar un evento (que no se pierda ni se duplique sin control)

- La tabla de salida (outbox) garantiza que el evento se guarde junto con la apuesta. El proceso que publica puede llegar a publicar el mismo evento dos veces si hay un problema de red, pero como todos los consumidores revisan el identificador del evento (operación 4), eso no causa ningún daño.

### Operación 6 — Enviar una notificación (no avisar dos veces "ganaste")

- Se guarda una marca por usuario, tipo de aviso y canal, durante 24 horas. Aquí aceptamos un mecanismo más barato porque no hay dinero en juego: lo peor que puede pasar es un correo repetido, no un premio repetido.

### Operaciones de administración

Publicar un resultado, cancelar una carrera o cambiar un rol también llevan clave de operación, y el cambio de estado se hace condicionado: "pasa la carrera a CERRADA **solo si está ABIERTA**". Doble clic del operador = un solo cambio.

### Resumen: las restricciones únicas que sostienen todo

| Dato | Restricción única sobre | Qué duplicado impide |
|---|---|---|
| Apuesta | usuario + clave de la operación | Cuatro clics, una sola apuesta |
| Movimiento de billetera | usuario + identificador de operación | Doble descuento, doble premio, doble devolución |
| Liquidación de una carrera | carrera + versión del resultado | Calcular dos veces la bolsa |
| Lote de pagos | carrera + versión + número de lote | Pagar dos veces el mismo lote |
| Evento procesado | consumidor + identificador del evento | Procesar dos veces el mismo evento |
| Tabla de salida | identificador del evento | Registrar dos veces el mismo evento |

---

## 7. Decisión 7 — El pico: 10.000 apuestas por segundo durante 30 segundos

Lo que hay que soportar: **100.000 usuarios conectados**, **10.000 apuestas por segundo** en los últimos 30 segundos (unas **300.000 apuestas**), respondiendo en **menos de un segundo** y **sin perder ninguna**.

### Dónde se atasca el sistema y qué hacemos

| # | Posible cuello de botella | Por qué aparece | Qué proponemos |
|---|---|---|---|
| B1 | **El total apostado de la carrera** | Si cada apuesta sumara al total de la carrera, las 10.000 apuestas por segundo tendrían que escribir **en el mismo dato**, y pasarían una por una. Es el atasco más grave y el menos evidente | **No llevamos ese total mientras la carrera está abierta.** La bolsa real se calcula **al cerrar**, sumando las apuestas, que ya no cambian. Las **cuotas estimadas** que se muestran en vivo se calculan aparte, leyendo las apuestas desde Kafka y sumando cada segundo. El enunciado dice que esas cuotas son aproximadas, así que esto no le quita exactitud a nada que importe |
| B2 | El saldo de un mismo usuario | Dos apuestas del mismo usuario al mismo tiempo tienen que esperar una a la otra | Es **justo lo que queremos**: así el saldo no queda negativo. Una persona no genera suficientes apuestas para que esto sea un problema. Lo cuidamos manteniendo la operación muy corta (nada de llamadas por la red en medio) |
| B3 | Guardar 10.000 apuestas por segundo | Es mucha escritura | Las apuestas se guardan **separadas por carrera**, así cada carrera grande escribe en su propio espacio y al pagar premios solo se lee ese espacio |
| B4 | Las conexiones a la base de datos | Cientos de copias del servicio, cada una con sus conexiones, son miles de conexiones | Un intermediario de conexiones delante de la base de datos: miles de conexiones de los servicios se atienden con unas doscientas reales |
| B5 | Las consultas compitiendo con las apuestas | 100.000 personas refrescando la pantalla | **Separamos los caminos:** los listados se responden con copias guardadas; las cuotas en vivo se **envían** a las apps desde el servidor en vez de que cada app pregunte cada dos segundos; el saldo se consulta en una copia de lectura de la base de datos |
| B6 | El API Gateway | 100.000 conexiones a la vez | No guarda nada, así que se agregan copias según haga falta. El JWT se verifica ahí mismo, sin llamar a Usuarios |
| B7 | Publicar a Kafka durante la apuesta | Si Kafka responde lento, frenaría las apuestas | La apuesta solo escribe el evento en su tabla de salida. Publicar ocurre después, por aparte |
| B8 | Pagar más de un millón de premios | No cabe en una sola petición | Se parte en lotes de 1.000 apuestas, que se publican como tareas en RabbitMQ y se reparten entre varios procesos en paralelo |

### Qué crece en el pico y qué no

| Componente | ¿Crece? | Cómo |
|---|---|---|
| Filtro de tráfico de la entrada | Sí, solo | Es un servicio administrado |
| API Gateway | **Sí, bastante** | Más copias, preparadas antes del evento |
| Envío de cuotas a las apps | **Sí, bastante** | Más copias; 100.000 conexiones se reparten entre unas veinte |
| Apuestas (recibir apuestas) | **Sí, bastante** | Más copias, preparadas antes del evento |
| Base de datos de Apuestas | **Se agranda la máquina**, no se multiplica | Es el único componente del camino de la apuesta que no se resuelve agregando copias: se dimensiona con holgura y se sube de tamaño antes de la final. Las consultas se desvían a copias de lectura |
| Apuestas (pago de premios) | Sí, pero **después** del pico | Pasa de cero a varios procesos cuando llega el resultado, y vuelve a cero al terminar |
| Carreras | **Casi nada** | Unas decenas de cambios por semana |
| Usuarios | Un poco | Su pico es el de inicios de sesión al abrir el evento, no el de apuestas |
| Notificaciones | Sí, **con retraso aceptable** | Los avisos salen al ritmo que puedan; que se acumulen un rato no es una falla |
| Estadísticas | **No en el momento** | Lee los eventos a su ritmo; el enunciado permite minutos de atraso |
| Auditoría | **No** | Escribe poco y de forma constante |
| Kafka | Sí, con más particiones | Más particiones, más consumidores leyendo en paralelo |
| RabbitMQ | Sí, con más procesos | Agregar procesos no exige reconfigurar nada |

**La ventaja que este negocio nos regala:** los picos **están en el calendario**. La final tiene fecha y hora conocidas, así que preparamos la capacidad media hora antes y la bajamos después, en vez de pagar máquinas grandes todo el mes o esperar que el crecimiento automático reaccione a tiempo a un pico de 30 segundos.

### Cómo garantizamos que no se pierde ninguna apuesta

1. **Nada se responde "aceptada" antes de quedar guardado.** Si el proceso se muere entre que guarda y que responde, la app reintenta con la misma clave y recibe la apuesta que ya existía.
2. **No encolamos antes de validar.** Encolar y revisar después permitiría "aceptar" apuestas que luego se rechazan.
3. **Los eventos salen por la tabla de salida**, así que una caída de Kafka no pierde ningún evento ni frena una apuesta.
4. **Si la base de datos se acerca al límite, rechazamos rápido y lo decimos** ("intenta de nuevo en un momento"), en vez de acumular peticiones adentro que terminarían todas en espera agotada.
5. **Limitamos las peticiones en la entrada**: un máximo de apuestas por segundo por usuario, y para la final una **sala de espera** que va dando turnos. Protege la base de datos de 100.000 personas reintentando a la vez.

### Cómo garantizamos que ninguna apuesta se acepte después del cierre

Tres barreras, de la más barata a la que manda:

1. **En la entrada:** el API Gateway ya sabe la hora de cierre y rechaza sin molestar a Apuestas. Ahorra tráfico, pero **no es el que decide**, porque su reloj puede estar corrido.
2. **En el servicio:** Apuestas descarta lo que su copia de la carrera marca como cerrado.
3. **En la base de datos (la que manda):** la comparación que decide es "¿la hora actual ya pasó la hora de cierre?", hecha **dentro de la operación y con el reloj de la base de datos**. Así todo el sistema usa **un solo reloj** y no importa que las decenas de copias del servicio tengan relojes ligeramente distintos.

Consecuencia que asumimos, tal como lo pide el enunciado: una apuesta enviada a las 20:14:59.900 que llega a las 20:15:00.050 **se rechaza**, aunque el usuario la haya enviado antes. Y como la hora de cierre **no cambia nunca** después de abrir la carrera, no importa que la copia local tenga unos segundos de atraso.

### Cómo garantizamos que el saldo nunca quede negativo

- **Un solo mecanismo, y lo hace la base de datos:** "resta este monto solo si el saldo alcanza". Si no alcanza, no resta nada y la apuesta se rechaza.
- **No** decidimos con una copia en caché (esa solo sirve para mostrar el saldo en pantalla), **no** leemos y escribimos en pasos separados, **no** reservamos saldo para confirmarlo después.
- Un proceso revisa continuamente que el saldo coincida con la suma de los movimientos y que nunca sea negativo.

### Por qué cabe en menos de un segundo

La mayor parte del segundo se la lleva la red del celular (ida y vuelta). Lo que hace el sistema es: verificar el JWT, una llamada interna y una operación de base de datos con cinco instrucciones. El trabajo del servidor se mide en milisegundos, así que queda margen de sobra: incluso si la base de datos tarda cinco veces más de lo normal en el pico, seguimos por debajo de un segundo.

> Estas cifras son requisitos de diseño y estimaciones, no resultados de pruebas. El siguiente paso natural sería medirlas con carga real.

---

## 8. Decisión 8 — Qué pasa cuando algo se cae

### Caso A — Notificaciones está caído. ¿Se puede seguir apostando?

**Sí, y el diseño lo garantiza.**

- Notificaciones **no participa en ningún paso de aceptar una apuesta**. Nadie lo llama y nadie lo espera: solo lee eventos de Kafka.
- Mientras está caído, los eventos **se acumulan en Kafka**, que los guarda una semana. Cuando vuelve, sigue leyendo desde donde quedó y se pone al día.
- Para no inundar al usuario de avisos viejos al recuperarse, descartamos los avisos que ya no tienen sentido ("empezó la carrera" de una carrera que ya terminó), pero **nunca** los de dinero ("recibiste EIA Coins"): esos siempre se entregan.
- Lo que nota el usuario: no le llega el aviso, pero ve su apuesta y su saldo correctos en la app, porque el dato real vive en Apuestas. La notificación es una comodidad, no la fuente de la verdad.
- Si lo que falla es el proveedor de correo o push, la cola reintenta con esperas crecientes y, tras varios intentos, aparta el mensaje y genera una alerta. Como hay una cola por canal, un canal caído no afecta a los otros.

### Caso B — La billetera está caída. ¿Se puede seguir apostando?

**No. Hay que rechazar la apuesta.** Y la diferencia con el caso A es de fondo:

| | Notificaciones | Billetera |
|---|---|---|
| ¿Es la fuente de la verdad? | No. Es un aviso | **Sí. Es donde está el dinero** |
| ¿Qué se rompe si sigo sin ella? | El usuario se entera más tarde | Se acepta una apuesta **sin haber descontado nada**: saldos en negativo y premios pagados con EIA Coins que no existían |
| ¿Se puede arreglar después? | Sí, se reenvía el aviso | **No sin perjudicar a alguien**: habría que anular apuestas que el usuario ya vio confirmadas. Y si la carrera ya corrió, es imposible |
| ¿Qué cuesta decir "no"? | Mucho: el usuario pierde la oportunidad de apostar por algo que no importa | Poco: "intenta de nuevo en un momento". Molesta, pero es honesto y se puede reintentar |

**La regla general:** *se puede degradar lo que informa; no se puede degradar lo que decide sobre el dinero.*

**Y hay algo más:** como la billetera **está dentro del mismo servicio que las apuestas**, "la billetera está caída" no existe como falla parcial. O el servicio está arriba, y entonces el descuento funciona, o está abajo, y entonces no se aceptan apuestas. **Eliminamos por diseño el estado peligroso** "se pueden hacer apuestas pero no se puede descontar". Es una de las razones más fuertes de la decisión 1.

**Alternativa que consideramos y descartamos:** aceptar la apuesta y descontar después ("apostar a crédito"). La descartamos porque permite gastar más de lo que se tiene mandando varias apuestas a la vez, y porque obligaría a anular apuestas ya confirmadas.

**Lo que sí hacemos** es que ese servicio se caiga lo menos posible: base de datos con copia en otro centro de datos y cambio automático si falla, copias del servicio en varias zonas, y despliegues que no interrumpen el servicio. Si aun así se cae en el pico, se responde "intenta de nuevo" y los reintentos de la app, al llevar la misma clave, no duplican nada. Si la caída se pasa de la hora de cierre, el operador puede **posponer el cierre**, que es una acción registrada.

### Otras fallas

| Falla | ¿Se puede apostar? | Qué pasa |
|---|---|---|
| **Kafka caído** | **Sí** | Las apuestas se guardan y los eventos esperan en la tabla de salida. Se atrasan cuotas, avisos, estadísticas y auditoría, pero no se pierde nada |
| **RabbitMQ caído** | **Sí** | No se pueden lanzar lotes de pago ni enviar avisos. Al volver se reanuda: los lotes pendientes están guardados. La meta de 15 minutos se incumple, con alerta |
| **Carreras caído** | **Sí, para las carreras ya abiertas** | Apuestas usa su copia local, que tiene la hora de cierre. No se pueden abrir, cerrar o cancelar carreras ni publicar resultados hasta que vuelva |
| **Usuarios caído** | **Sí, con la sesión ya abierta** | El JWT se verifica en el API Gateway. No hay nuevos registros ni nuevos inicios de sesión |
| **Memoria caché caída** | **Sí** | Se pierden copias y conteos; se aplican límites más conservadores. Nada importante vive solo ahí |
| **Auditoría caída** | **Sí** | Los eventos esperan en Kafka. La auditoría nunca bloquea una operación, pero su atraso es una alerta grave |

### Caso C — El resultado estaba equivocado y ya se pagaron premios

Diez minutos después de publicar el resultado, el operador descubre que la foto de llegada se interpretó mal. Parte de los premios ya se pagó.

**Principio: nada se borra y nada se sobrescribe. Se corrige hacia adelante, dejando todo registrado.**

1. **Permiso reforzado.** Corregir un resultado es la operación más delicada del sistema: la pide un operador y la **aprueba un administrador distinto**, los dos con doble factor, y queda registrado quién hizo qué.
2. **El resultado no se edita: se agrega una versión nueva.** Carreras guarda el resultado como "versión 2" y publica `ResultadoCorregido` con el ganador anterior, el nuevo, el motivo y los responsables. La versión 1 queda guardada para siempre.
3. **Los premios se recalculan como versión 2, sin tocar la versión 1.** El proceso de pago:
   - calcula la liquidación correcta (la misma bolsa, la misma comisión del 10 %, otros ganadores) y publica `LiquidacionCalculada` versión 2;
   - **registra la reversión** de cada premio pagado por error: el movimiento original **no se borra**, se le agrega otro que lo anula, que es la forma correcta de llevar cuentas;
   - paga los premios de la versión 2, con sus propios identificadores de operación, así que no hay riesgo de pagar dos veces.
4. **Si el usuario ya gastó el premio.** Como los EIA Coins no se canjean ni se retiran, puede quedar con **saldo negativo marcado como deuda**: no puede apostar hasta regularizar y se le explica por qué. *Esto es un supuesto de negocio que declaramos: la otra opción es que la casa absorba la diferencia, y el diseño soporta las dos cambiando solo esa política.*
5. **Aviso obligatorio** a los dos afectados: a quien pierde el premio y a quien lo gana, con el motivo.
6. **Todo queda reconstruible.** El auditor puede seguir la historia completa: resultado 1 → cómo se calcularon sus premios → qué se pagó → quién corrigió y por qué → qué se revirtió → resultado 2 → qué se pagó al final. Esto es exactamente lo que pide el enunciado.
7. **Prevención.** Para que el caso ocurra lo menos posible, proponemos esperar **dos minutos** entre publicar el resultado y empezar a pagar. Cuesta 2 de los 15 minutos de la meta y evita la mayoría de las correcciones después del pago.

---

## 9. Decisión 9 — Datos y consistencia

### Qué base de datos usa cada servicio

**Regla: ningún servicio lee la base de datos de otro.** Si necesita un dato ajeno, lo pide por una llamada o se lo entrega un evento.

| Servicio | Qué usa | Por qué |
|---|---|---|
| **Apuestas** | Base de datos relacional propia y dedicada, con copia en otro centro de datos y copias de lectura | Es el único que necesita guardar varias cosas en un solo paso, restricciones únicas y atender de a una las apuestas del mismo usuario. Eso es justo lo que una base relacional hace mejor. Y va en su propia máquina porque es la que sufre el pico |
| **Usuarios** | Base relacional propia | Datos sensibles: las contraseñas se guardan transformadas, nunca legibles, y el acceso es muy restringido |
| **Carreras** | Base relacional propia | Modelo pequeño, con estados y la relación carrera–mediano |
| **Notificaciones** | Base relacional pequeña | Plantillas, preferencias y registro de envíos |
| **Estadísticas** | Almacén de histórico (archivos) + base de datos pensada para reportes | Millones de registros al día y consultas que suman y agrupan. Una base relacional normal sería lenta y cara para esto |
| **Auditoría** | Almacenamiento que **no permite modificar ni borrar**, con cinco años de retención | "Registro inalterable" exige un almacenamiento que lo impida de verdad, no solo permisos que lo prohíban |

**Decisión de costo:** al principio, las bases de Usuarios, Carreras y Notificaciones viven en **una sola máquina compartida**, pero cada una con su base, su esquema y sus credenciales, y sin consultas cruzadas. Separarlas después es mover datos, no rediseñar.

### Qué necesita consistencia fuerte y qué puede ser eventual

| Dato | Consistencia | Por qué |
|---|---|---|
| **Saldo y movimientos de la billetera** | **Fuerte** | Gastar dos veces o quedar en negativo es inaceptable |
| **Aceptar o rechazar una apuesta** | **Fuerte** | Es una respuesta que compromete dinero |
| **La hora de cierre** | **Fuerte** (un solo reloj: el de la base de datos) | Es una regla del negocio y tiene que ser auditable |
| **El cálculo de los premios** | **Fuerte** | Debe poder reproducirse exactamente |
| **El estado de la carrera** | **Fuerte**, dentro de Carreras | Los cambios de estado son únicos y condicionados |
| Copia de las carreras abiertas en Apuestas | **Eventual** (segundos), pero **segura** | La hora de cierre y los participantes no cambian después de abrir, así que un atraso no puede producir una decisión equivocada. Y si falta el dato, se rechaza |
| Lista de usuarios bloqueados en Apuestas | Eventual (segundos) | Que un bloqueo tarde dos segundos en propagarse es aceptable |
| **Cuotas estimadas** | **Eventual** (uno o dos segundos) | El enunciado las define como aproximadas |
| Estadísticas | Eventual (minutos) | Supuesto del enunciado |
| Reportes premium | Eventual (hasta un día) | Supuesto del enunciado |
| Registro de auditoría | Puede **llegar tarde**, pero no puede **faltar** | Segundos de atraso están bien; un hueco, no |
| Notificaciones | Eventual | No es la fuente de la verdad |

### Cómo mantenemos de acuerdo la apuesta y el descuento

**La respuesta corta: no están en servicios distintos, justamente para que este problema no exista.**

La apuesta, el movimiento de la billetera y los eventos a publicar se guardan **en un solo paso**. No hay un momento en que la apuesta exista sin su descuento. **No usamos saga** en el camino de la apuesta porque no la necesitamos, y el enunciado pide usar esos patrones solo si realmente hacen falta.

Los únicos patrones repartidos que sí usamos:

| Patrón | Dónde | Por qué hace falta |
|---|---|---|
| **Tabla de salida (outbox)** | En Apuestas y Carreras, al publicar eventos | Sin ella, el sistema podría guardar la apuesta y perder el evento, o publicar un evento de algo que al final no se guardó |
| **Registro de eventos ya procesados** | En todos los consumidores | Porque Kafka y RabbitMQ entregan el mismo mensaje más de una vez |
| **Pago de premios por lotes** | Al pagar y al corregir un resultado | Es un proceso largo, de minutos, que debe poder reanudarse y corregirse. Pero **cada lote es una operación local**, así que no hace falta coordinar servicios |
| **Saga con reserva de saldo** | ❌ **No la usamos** | Solo haría falta si la billetera estuviera en otro servicio. Queda anotada como camino de crecimiento (sección 13) |

### Dónde vive el historial

- **Kafka** es el canal y la memoria de corto plazo: guarda los eventos una semana, suficiente para volver a leerlos si algo falló.
- El **almacén de histórico** guarda **todos** los eventos, tal como salieron, para siempre. Sirve para recalcular estadísticas con reglas nuevas sin tocar los servicios.
- La **base de reportes** guarda los números ya sumados, para que un reporte premium responda en segundos.
- **Auditoría** es un almacén aparte y de otra naturaleza: no se puede modificar ni borrar, cada registro incluye una huella del anterior (de modo que si alguien altera o elimina algo, se nota), y se conserva cinco años.
- En la base de datos de Apuestas se quedan los últimos 90 días; lo más antiguo se archiva. Así el camino de la apuesta trabaja siempre sobre una base pequeña y rápida, y el histórico completo sigue disponible.

### Cómo se reparte la bolsa (fórmula)

Como el enunciado la fija, la escribimos explícita:

- **bolsa** = suma de todo lo apostado en la carrera.
- **comisión** = 10 % de la bolsa.
- **a repartir** = bolsa − comisión.
- **cuánto paga cada EIA Coin apostado** = a repartir ÷ suma de lo apostado por los que ganaron.
- **premio de cada uno** = su monto × ese valor.

Todo se calcula en números enteros, nunca en decimales, para que las cuentas cierren exactamente. Lo que sobra al redondear se queda en la comisión y queda registrado, para que el auditor pueda cuadrar hasta el último EIA Coin.

**Supuesto que declaramos:** si nadie apostó al mediano ganador, no hay ganadores; se devuelve el 100 % de lo apostado y no se cobra comisión. El enunciado no define este caso y afecta la fórmula.

---

## 10. Seguridad

### Qué es público y qué es privado

| Zona | Qué hay ahí |
|---|---|
| **Público (Internet)** | El filtro de tráfico y el **API Gateway**, y por ahí el registro y el inicio de sesión. Es lo único alcanzable desde Internet, siempre con conexión cifrada |
| **Red privada: servicios** | Apuestas, Usuarios, Carreras, Notificaciones, Estadísticas y Auditoría. Sin dirección pública: solo se llega a ellos desde el API Gateway, y solo las rutas que están permitidas explícitamente |
| **Red privada: datos y mensajería** | Bases de datos, Kafka, RabbitMQ, caché y almacenamiento. Sin salida a Internet, y solo accesibles desde los servicios que los necesitan |
| **Red privada: procesos de trabajo** | Pago de premios, envío de avisos y cálculo de estadísticas. No reciben peticiones de nadie: solo leen de Kafka y de RabbitMQ |
| **Administración** | El panel del operador y del administrador y la consulta del auditor **no se exponen al público**: se llega por una red privada, con doble factor obligatorio |

### Inicio de sesión y permisos

- Usuarios entrega un **JWT** —un token de sesión firmado por él mismo, que cualquiera puede comprobar con su clave pública—, de **corta duración** (minutos), más un token para renovarlo que **solo sirve una vez** (si alguien lo reutiliza, se detecta el robo).
- El JWT **se verifica en el API Gateway**, sin preguntarle a Usuarios en cada petición. Así Usuarios no es un punto único de falla para las sesiones ya abiertas.
- Para bloquear a alguien al instante, el API Gateway consulta una lista de sesiones revocadas, que compensa la duración del JWT.
- **Doble factor obligatorio** para operador, administrador y auditor.
- **Permisos en dos niveles:** el API Gateway bloquea lo evidente (un apostador que intenta entrar a la administración) y cada servicio revisa además **sobre qué dato** se está operando: un apostador solo puede ver *sus* apuestas y *su* billetera. El identificador del usuario **siempre se toma del JWT**, nunca de lo que manda la app.
- Los cuatro roles: **apostador** (apostar y consultar lo propio), **operador** (ciclo de vida de las carreras y publicar resultados), **administrador** (usuarios, roles, bloqueos y aprobar correcciones) y **auditor** (**solo lectura** del registro).
- **Separación de responsabilidades:** quien publica un resultado no puede aprobar su corrección, y nadie puede alterar el registro de auditoría.

### Protección de las APIs y contra bots

- **Límites de peticiones por capas** (rate limiting): por dirección de origen en la entrada, por usuario y por operación en el API Gateway (por ejemplo, un máximo de apuestas por segundo por usuario, y pocos intentos de inicio de sesión por minuto), y una **sala de espera** para la final.
- **Filtro de tráfico** contra ataques conocidos y contra saturación, validación estricta de todo lo que llega y límites de tamaño.
- **Contra bots:** desafío al registrarse y después de varios intentos fallidos de inicio de sesión, y una identificación del dispositivo que se envía con la apuesta. Con eso, el módulo de fraude detecta los dos casos que menciona el enunciado: muchas cuentas apostando desde el mismo dispositivo y ráfagas de apuestas en los segundos previos al cierre. La acción automática es un bloqueo preventivo que un administrador revisa.
- Nunca se mandan datos personales ni claves en la dirección de la petición.

### Cifrado y manejo de credenciales

- **En tránsito:** todo cifrado, tanto de cara a Internet como entre servicios internos y hacia las bases de datos, Kafka y RabbitMQ.
- **En reposo:** discos y respaldos cifrados; los datos personales, además, cifrados campo por campo. Los movimientos de billetera se tratan como datos sensibles y su consulta queda registrada.
- **Contraseñas:** guardadas transformadas, con un valor distinto por usuario, y nunca recuperables ni visibles en ningún registro.
- **Claves y credenciales:** en un gestor de secretos, con rotación automática, y entregadas al servicio al arrancar. **Nunca en el código ni en el repositorio.**
- **Registros del sistema:** se borran automáticamente los JWT, las contraseñas y los datos personales antes de guardarlos.

### Registro de las acciones de administración

- **Toda** acción de un operador o un administrador (crear, abrir o cancelar una carrera, publicar o corregir un resultado, bloquear un usuario, cambiar un rol, ajustar un saldo) se registra en Auditoría con quién lo hizo, su rol, desde dónde, cuándo, qué había antes, qué quedó después y un motivo escrito obligatorio.
- Las acciones de mayor riesgo (corregir un resultado, ajustar un saldo a mano) exigen **dos personas distintas**: quien la ejecuta y quien la aprueba.
- El registro es **imposible de alterar incluso para los administradores**. Nadie en la empresa puede borrar su propio rastro, y eso es lo que convierte la auditoría en una garantía de verdad.

---

## 11. Costos

> *"No quiero pagar una infraestructura de Netflix para una carrera de cinco medianos."*

| Decisión | Por qué ahorra |
|---|---|
| **Seis servicios, no veinte** | Cada servicio extra cuesta su propia base de datos, su propio despliegue, su propio monitoreo y atención del equipo. Juntamos Medianos con Carreras, los premios con Apuestas y el fraude con Estadísticas porque separarlos no compraba nada |
| **Una sola máquina de base de datos** para Usuarios, Carreras y Notificaciones | Tres máquinas pequeñas cuestan casi el triple que una mediana. La separación lógica queda intacta, así que dividirlas luego es fácil |
| **Máquina dedicada solo para Apuestas** | Es el único que sufre el pico. Aislarlo evita que un reporte pesado le quite capacidad |
| **Preparar la capacidad según el calendario de carreras** | Los picos no son sorpresa: se agranda media hora antes de la final y se baja después. Pagamos el pico unas horas al mes, no todo el mes. Es, de lejos, la decisión que más ahorra |
| **Los procesos de pago de premios solo existen mientras trabajan** | Trabajan unos diez minutos después de cada carrera. Tenerlos encendidos siempre sería absurdo |
| **Todo administrado por el proveedor** (bases de datos, Kafka, RabbitMQ, caché, almacenamiento) | El costo real de una plataforma así es el equipo que la mantiene, no las máquinas. Con servicios administrados no hace falta un equipo de infraestructura |
| **Un clúster de Kafka y uno de RabbitMQ** | Evita exactamente el escenario que el enunciado ridiculiza |
| **El histórico se guarda en almacenamiento barato** | En la base de datos se quedan 90 días; el resto se archiva. Guardar cinco años de auditoría en una base relacional costaría muchísimo más |
| **Enviar las cuotas a las apps en vez de que pregunten** | 100.000 personas preguntando cada dos segundos serían 50.000 consultas por segundo inútiles |
| **No llevar el total apostado mientras la carrera está abierta** | Además de quitar el atasco, evita tener que agrandar la base de datos para aguantar una competencia que nos habríamos creado nosotros |
| **Sin presencia en varias regiones del mundo al principio** | Duplicaría el costo para un negocio de una sola universidad. Se agrega solo si el negocio lo pide |

**Orden de magnitud:** la base mensual estaría en el orden de **unos pocos miles de dólares**, y cada final costaría unas **decenas de dólares extra** por la capacidad adicional de un par de horas. Es una estimación para ubicar la escala del gasto, no una cotización: depende del proveedor, la región y el dimensionamiento real.

Si Dyllan quisiera arrancar aún más barato, la variante mínima es quitar RabbitMQ y usar una cola simple del proveedor, y empezar con Kafka en una sola zona (aceptando menos resistencia a fallas). **El diseño lógico no cambia en nada.**

---

## 12. Los tres ADR

### ADR-001 — Arquitectura híbrida: el dinero en un servicio, lo demás aparte

**Estado:** aceptada.

**Contexto.** La plataforma debe aceptar 10.000 apuestas por segundo durante 30 segundos respondiendo en menos de un segundo, no perder ninguna apuesta ni ningún movimiento de billetera, impedir que alguien gaste dos veces sus EIA Coins, pagar más de un millón de premios en 15 minutos, guardar estadísticas de millones de registros diarios y auditoría de cinco años — con un presupuesto modesto y un equipo pequeño. Los requisitos del dinero y los de escala apuntan en direcciones opuestas.

**Opciones consideradas.**
1. **Un solo monolito con todo adentro.** Simple y barato, pero junta fallas y crecimiento: una caída de notificaciones o un pago masivo de premios afectaría a las apuestas, y crecer para el pico obligaría a agrandar todo.
2. **Un microservicio por capacidad (diez o más).** Máxima independencia, pero obliga a coordinar dos servicios en cada apuesta, gasta tiempo del segundo de respuesta y multiplica las formas de fallar. El enunciado penaliza el sobrediseño.
3. **Recibir la apuesta en una cola y validarla después.** Incompatible con responder "aceptada o rechazada" en menos de un segundo.
4. **Híbrida** (elegida).

**Decisión.** Un servicio **Apuestas** que contiene apuestas, billetera y pago de premios, con una sola base de datos; cinco servicios independientes (**Usuarios**, **Carreras**, **Notificaciones**, **Estadísticas**, **Auditoría**) detrás de un API Gateway, comunicados por eventos.

**Consecuencias.**
*Se gana:* las reglas del dinero se cumplen sin coordinar servicios; el tiempo de respuesta es predecible; crece solo lo que necesita crecer; una caída de notificaciones, estadísticas o auditoría no afecta a nadie; son seis piezas que un equipo pequeño puede mantener.
*Se pierde:* si Apuestas se cae, no hay apuestas (lo mitigamos con copias en varias zonas y con que los reintentos no duplican nada); su base de datos es lo único del camino de la apuesta que se resuelve agrandando la máquina; y exige **disciplina del equipo** para que las partes internas no se mezclen con el tiempo.

---

### ADR-002 — Guardar la apuesta y descontar el saldo en un solo paso

**Estado:** aceptada.

**Contexto.** Antes de aceptar una apuesta hay que comprobar que el usuario existe, que la carrera está abierta, que el mediano participa, que hay saldo y que la apuesta no está repetida; y hay que descontar los EIA Coins. El requisito es tajante: *nunca* se puede gastar dos veces el mismo saldo y *ninguna* apuesta aceptada se puede perder. Además hay que responder en menos de un segundo, y los usuarios reintentan (el caso de los cuatro clics).

**Opciones consideradas.**
1. **Coordinar dos servicios con reserva de saldo** (saga): reservar, crear la apuesta y después confirmar o devolver la reserva. Agrega estados intermedios, saldo bloqueado cuando una devolución se pierde, pasos por la red en cada apuesta y un proceso permanente de revisión.
2. **Descontar después, de forma asíncrona** ("apostar a crédito"): la más rápida, pero permite gastar más de lo que se tiene mandando apuestas en paralelo. Rompe la regla central.
3. **Guardar la billetera como una lista de movimientos y calcular el saldo aparte:** excelente para auditar, pero el saldo calculado llega con retraso, así que para comprobar los fondos haría falta otro mecanismo de todos modos. Mucha complejidad para el mismo resultado.
4. **Un solo paso en la misma base de datos** (elegida).

**Decisión.** La apuesta, el movimiento de la billetera, el nuevo saldo y los eventos a publicar se guardan **todos juntos o ninguno**. Que nadie gaste dos veces lo impide descontar "solo si el saldo alcanza"; que no se duplique la apuesta lo impide una restricción única sobre usuario + clave de la operación; que no se pierda el evento lo garantiza la tabla de salida.

**Consecuencias.**
*Se gana:* es imposible gastar dos veces o quedar en negativo; no existe un momento en que la apuesta esté guardada y el descuento no; no hay nada que corregir después en el camino de la apuesta; y el caso B deja de ser un dilema, porque el estado "apuestas sí, billetera no" no existe.
*Se pierde:* Apuestas y Billetera no se pueden actualizar ni hacer crecer por separado y comparten su suerte si hay una falla; su base de datos concentra la escritura; y las apuestas simultáneas de un mismo usuario se atienden de a una (efecto deseado, pero es un límite por usuario). Si el volumen creciera cien veces, separar la billetera queda documentado como paso de crecimiento, con el costo que hoy evitamos pagar por adelantado.

---

### ADR-003 — Kafka para los hechos, RabbitMQ para las tareas

**Estado:** aceptada.

**Contexto.** Hay dos necesidades muy distintas. (a) Hechos del negocio que le interesan al mismo tiempo a estadísticas, fraude, auditoría y notificaciones, con volumen de 10.000 por segundo, que hay que guardar y poder volver a leer, y que además hay que ir sumando para mostrar las cuotas estimadas. (b) Trabajo por hacer: millones de pagos partidos en lotes que hay que repartir entre varios procesos, y envíos a proveedores externos que fallan y hay que reintentar sin frenar a los demás.

**Opciones consideradas.**
1. **Solo Kafka:** habría que programar a mano los reintentos con espera, un mensaje problemático frenaría a los que vienen detrás, y el número de procesos de pago quedaría limitado por las particiones.
2. **Solo RabbitMQ:** no se puede volver a leer lo ya consumido (se pierde la capacidad de reconstruir la auditoría o recalcular estadísticas), mandar el mismo hecho a cuatro consumidores sale caro, y no sirve para ir sumando las apuestas de las cuotas.
3. **Ninguno, todo con llamadas directas:** rompe el requisito de que notificaciones no bloquee una apuesta y vuelve imposible pagar un millón de premios.
4. **Los dos, con frontera estricta** (elegida).

**Decisión.** **Kafka** lleva los hechos: `ApuestaAceptada`, `ResultadoPublicado`, `MovimientoBilleteraRegistrado`, los eventos de carrera y las cuotas. **RabbitMQ** lleva las tareas: `LiquidarLote`, `EnviarNotificacion`, `RecalcularEstadisticas`. Una sola regla: *hecho que varios leen y quiero poder releer → Kafka; tarea que alguien ejecuta y puede reintentarse → RabbitMQ.*

**Consecuencias.**
*Se gana:* la herramienta adecuada para cada caso; historial y relectura para auditoría y estadísticas; reintentos por mensaje sin frenar la cola; y la posibilidad de agregar procesos de pago sin tocar la configuración.
*Se pierde:* dos tecnologías que aprender, vigilar y pagar. Lo acotamos con servicios administrados, un solo clúster de cada uno, una regla clara y una librería interna compartida para que nadie tenga que conocer los detalles de los dos. Y dejamos el plan de salida escrito: si estorba, se quita RabbitMQ y se conserva Kafka.

*(Si hubiera un cuarto ADR, serían la estrategia de idempotencia basada en restricciones únicas de la base de datos, y la decisión de no llevar el total apostado mientras la carrera está abierta.)*

---

## 13. Pregunta final — ¿Qué haríamos hoy y cómo creceríamos cien veces?

### Hoy

Haríamos exactamente lo que propone este documento: **un servicio con el dinero adentro, cinco servicios independientes alrededor, Kafka para los hechos y RabbitMQ para las tareas, todo sobre servicios administrados y con la capacidad preparada según el calendario de carreras.**

| Criterio | Por qué esta arquitectura hoy |
|---|---|
| **Complejidad** | La mínima que resuelve el problema: seis servicios. Cada pieza que agregamos (tabla de salida, control de duplicados, Kafka y RabbitMQ, pago por lotes) responde a un requisito concreto del enunciado y podemos señalar cuál |
| **Escalabilidad** | Lo que debe crecer, crece agregando copias. Lo que no lo necesita, no se paga. Y como el pico está en el calendario, se prepara en vez de improvisarse |
| **Resiliencia** | Notificaciones, estadísticas, auditoría, Kafka e incluso Usuarios pueden caerse y la gente sigue apostando. Lo único que no se degrada es el dinero, y eso es a propósito |
| **Consistencia** | Fuerte donde está el dinero, eventual donde el negocio lo permite (cuotas, estadísticas, avisos). El límite entre las dos coincide con el límite entre servicios |
| **Seguridad** | Solo el API Gateway mira a Internet; todo lo demás está en red privada. Sesiones cortas, doble factor y dos personas para las operaciones delicadas, y una auditoría que nadie puede alterar |
| **Costo** | Pocos miles de dólares al mes de base y unas decenas extra por evento grande, sin equipo de infraestructura |
| **Mantenibilidad** | Una sola aplicación donde está lo difícil (el dinero y sus reglas, todas comprobables en una sola base de datos) y servicios pequeños donde está lo independiente |

### Cómo creceríamos cien veces

Lo importante no es la lista de pasos, sino que **ninguno exige rediseñar**: cada uno separa algo por una línea que ya existe hoy.

| Paso | Cuándo lo haríamos (señal medible) | Qué haríamos | Qué lo hace posible desde hoy |
|---|---|---|---|
| **1. Agrandar y separar lecturas** | Las apuestas empiezan a tardar más de lo aceptable, o la base de datos pasa del 60 % de uso en el pico | Máquina más grande, más copias de lectura, más particiones en Kafka | Las consultas ya están separadas de las escrituras, y las apuestas ya se guardan separadas por carrera |
| **2. Separar el pago de premios** | El pago de premios le quita capacidad a las apuestas | Los procesos de pago pasan a su propia máquina y calculan leyendo de una copia | Ya se despliegan aparte, aunque hoy comparten la aplicación |
| **3. Convertir el pago de premios en un servicio** | Más de cinco millones de apuestas por carrera, o la meta de 15 minutos en riesgo | Servicio propio, que acredita llamando a una interfaz de la billetera | Los pagos ya llevan identificador de operación, así que pasar por la red no cambia su significado |
| **4. Preparar las consultas aparte** | Las consultas de "mis apuestas" y "mis movimientos" dominan la carga | Guardarlas ya listas en otro almacén, alimentado por los eventos | Esos eventos ya existen y ya llegan ordenados por usuario |
| **5. Separar la billetera** | Más de 50.000 apuestas por segundo sostenidas, o equipos que necesitan trabajar por separado | Billetera como servicio propio, y la apuesta pasa a reservar, crear y confirmar | Es el paso que **hoy evitamos a propósito** (ADR-002). El historial de movimientos ya está preparado para que una reserva sea un movimiento más |
| **6. Repartir los datos en varias bases** | La máquina de la base de datos ya no se puede agrandar más | Dividir las billeteras por usuario y las apuestas por carrera | Son justo las claves que ya usamos hoy para repartir los eventos |
| **7. Varias regiones** | Público fuera de la región, o exigencia de recuperación ante desastres | Una región activa y otra de respaldo, con copia continua | Ya está claro qué datos exigen consistencia fuerte y cuáles toleran una copia con retraso |
| **8. Plataforma de datos** | Los reportes premium se vuelven una línea de negocio real | Capas de datos crudos, curados y listos para consultar, y modelos de fraude entrenados con el histórico | El almacén de histórico recibe todos los eventos desde el primer día: **se puede recalcular toda la historia con reglas nuevas** |

**El principio:** lo que proponemos hoy no es "la arquitectura pequeña que después habrá que botar", sino **la arquitectura grande con las separaciones todavía sin hacer**. Las tres cosas que permiten crecer cien veces sin reescribir están desde el primer día: (1) los eventos ya se reparten por carrera y por usuario, que son las mismas claves con las que después se dividirían los datos; (2) toda operación de dinero ya tiene un identificador único, así que el pago puede mudarse detrás de una llamada sin cambiar su significado; y (3) las partes internas de Apuestas son módulos de verdad, así que separar uno es empaquetarlo, no reescribirlo.

> Que cien veces el pico (un millón de apuestas por segundo) sea alcanzable no es algo que este documento demuestre: es un camino, y cada paso habría que medirlo antes de darlo.

### Si en la sustentación piden apuestas en vivo durante la carrera

El enunciado avisa que pedirán un cambio de requisitos y da ese ejemplo. Así lo absorbería la propuesta:

| Qué cambia | Qué habría que tocar | Por qué es barato |
|---|---|---|
| El cierre deja de ser un solo instante | La copia de carreras pasa de tener una hora de cierre a tener **varias apuestas posibles, cada una con su propia ventana**. La comprobación sigue siendo la misma: ¿ya pasó su hora de cierre? | La regla que decide el cierre ya vive en un solo lugar |
| La bolsa se cierra por cada ventana, no por carrera | El cálculo de premios se identifica también por la ventana; la fórmula no cambia | Los premios ya se calculan por lotes y ya están versionados |
| Las cuotas deben actualizarse más rápido | Sumar las apuestas cada cuarto de segundo en vez de cada segundo | Las cuotas ya se calculan **fuera** de la base de datos; subir la frecuencia solo cuesta cómputo |
| El operador informa lo que pasa en la carrera | Eventos nuevos (una vuelta completada, una ventana que se abre o se cierra) en el mismo topic de carreras | Agregar un evento no rompe a los consumidores que ya existen: simplemente lo ignoran |
| Aumenta el riesgo de fraude (apostar sabiendo el resultado) | Una regla nueva en el módulo de fraude y la posibilidad de **suspender automáticamente** las apuestas cuando pasa algo relevante en la carrera | El módulo de fraude ya lee las apuestas aceptadas y rechazadas casi al instante |
| Más apuestas por carrera | Más escritura, misma estructura | Ya guardamos las apuestas separadas por carrera y ya no llevamos un total compartido |

**Nada de esto toca la parte del dinero:** la apuesta en vivo sigue siendo un solo paso en la base de datos, con descuento condicionado y clave de operación. Lo que cambia es el modelo del negocio, no la arquitectura — y eso es señal de que las fronteras quedaron en el lugar correcto.

---

## 14. Lo que cada diagrama debe mostrar

**Diagrama general** (entregable 12.1): clientes → API Gateway → servicios → bases de datos → Kafka / RabbitMQ → consumidores, con **tres tipos de línea** bien distinguibles: continua para lo síncrono, punteada para los eventos de Kafka y gruesa para las tareas de RabbitMQ. Debe verse la frontera entre lo público y la red privada, y que el pago de premios pertenece a Apuestas.

**Diagrama de secuencia de una apuesta** (entregable 12.2): desde que el usuario presiona APOSTAR hasta que recibe la confirmación, incluyendo el descuento. Pasos:

1. El usuario presiona APOSTAR. La app envía la apuesta con la clave de la operación que generó al abrir el formulario.
2. El API Gateway verifica el JWT y los límites de peticiones.
3. Llama a Apuestas.
4. Apuestas mira si esa clave ya fue atendida. **Si ya existe, devuelve la respuesta original y termina.**
5. En un solo paso: comprueba la carrera (abierta, antes del cierre, mediano participante) con el reloj de la base de datos; descuenta el saldo solo si alcanza; guarda la apuesta; guarda el movimiento; guarda los eventos en la tabla de salida.
6. Responde al usuario: apuesta aceptada y saldo restante.
7. **Fuera de la respuesta:** los eventos salen a Kafka y de ahí a notificaciones, cuotas, estadísticas y auditoría.

Vale la pena dibujar también las ramas de **carrera cerrada** y **saldo insuficiente**, y sobre todo la de los **clics 2, 3 y 4**, que terminan en el paso 4 devolviendo la misma apuesta, sin descontar de nuevo. Ese es el corazón del ejercicio.

**Diagrama de mensajería** (entregable 12.3, dibujado en [`diagrama-mensajeria.md`](diagrama-mensajeria.md)):

- **Kafka:** quién publica, en qué topic, con cuántas particiones y qué grupos de consumidores lo leen. Los topics son `apuestas.aceptadas`, `apuestas.rechazadas`, `billetera.movimientos`, `carreras.eventos`, `carreras.resultados`, `premios.eventos`, `cuotas.estimadas` y `usuarios.eventos`. La clave es `carreraId`, salvo en los movimientos de billetera y los eventos de usuario, donde es `usuarioId`. Cada grupo de consumidores (estadísticas, auditoría, cuotas, notificaciones y los demás) lleva su propia posición de lectura.
- **RabbitMQ:** productor, exchange, routing key, cola y consumidores, con la cola de mensajes con problemas. Son los tres de la tabla de la decisión 4.

**Diagrama de estados de la carrera:** PROGRAMADA → ABIERTA → CERRADA → EN_CURSO → FINALIZADA → LIQUIDADA, con CANCELADA alcanzable desde cualquier estado anterior a FINALIZADA, y el evento que se publica en cada transición.

---

## 15. Dónde queda cada requisito del enunciado

| Lo que pide el enunciado | Dónde está |
|---|---|
| Decisión 1 — estilo y alternativas descartadas | Sección 1 (tres descartadas) y ADR-001 |
| Decisión 2 — división de servicios | Sección 2 |
| Decisión 3 — comunicación síncrona y qué pasa si no responde | Sección 3 |
| Decisión 4 — eventos, un solo idioma, tabla y contenido mínimo | Sección 4 |
| Decisión 5 — RabbitMQ y Kafka | Sección 5 y ADR-003 |
| Decisión 6 — idempotencia (pide tres operaciones, damos seis) | Sección 6 |
| Decisión 7 — 10.000 apuestas por segundo | Sección 7 |
| Decisión 8 — casos A, B y C | Sección 8 |
| Decisión 9 — datos y consistencia | Sección 9 |
| Seguridad, y qué es público y qué privado | Sección 10 |
| Costos | Sección 11 |
| Tres ADR de máximo una página | Sección 12 |
| Pregunta final y crecimiento a cien veces | Sección 13 |
| Cambio de requisitos de la sustentación | Sección 13 |
| Insumos de los diagramas | Sección 14 |
| "Ningún mediano recibe dos premios por cuatro clics" | Sección 6, operaciones 1 y 3 |

---

## 16. Conclusiones

1. **El problema no es de tamaño, es de exactitud.** 10.000 apuestas por segundo es exigente, pero se resuelve con herramientas conocidas. Lo verdaderamente difícil es que ningún EIA Coin se gaste dos veces y que ninguna apuesta aceptada se pierda. Por eso la arquitectura se organiza alrededor del dinero y no alrededor del tráfico.
2. **La decisión más valiosa fue la que evitó complejidad, no la que la agregó.** Guardar la apuesta y el descuento en un solo paso eliminó de una vez la coordinación entre servicios, los estados intermedios, el saldo bloqueado y la mitad de las formas de fallar.
3. **La idempotencia no es una funcionalidad, es algo que atraviesa todo el diseño.** Está en la clave que genera la app, en las restricciones únicas de la base de datos, en el identificador de cada movimiento, en los lotes de pago y en el consumo de eventos. Es lo que convierte "el usuario presionó cuatro veces" en algo que no pasa nada.
4. **Separamos donde eso compra disponibilidad, no por moda.** Notificaciones, Estadísticas y Auditoría están aparte porque su caída no debe afectar a nadie. Medianos, Resultados y Premios no están aparte porque separarlos solo habría comprado demora y factura.
5. **Que los picos sean predecibles es un regalo de este negocio.** Como el calendario de carreras se conoce de antemano, la plataforma recibe 100.000 usuarios preparando la capacidad en vez de pagarla todo el mes.
6. **Corregir hacia adelante conserva la confianza.** Resultados versionados, movimientos que se anulan en vez de borrarse y un registro que nadie puede alterar permiten admitir un error humano sin perder el rastro de lo que pasó. Y el rastro es lo único que una casa de apuestas no se puede permitir perder.
7. **Esta propuesta está pensada para separarse, no para reescribirse.** Las claves con que hoy repartimos los eventos son las mismas con que mañana se dividirían los datos; las partes internas de hoy son los servicios de mañana.
8. **Complejidad justa:** seis servicios, Kafka y RabbitMQ administrados, tres bases de datos, un almacén de histórico y ningún clúster que mantener nosotros. Suficiente para 100.000 usuarios y para cinco medianos. Dyllan conserva su negocio y el equipo conserva su empleo.

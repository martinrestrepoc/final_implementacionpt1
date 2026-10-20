# Guion de la presentación

**La Gran Liga de Apuestas de Medianos EIA** · 20 diapositivas, portada incluida.

Lo que está bajo **En pantalla** es lo que se proyecta. Lo que está bajo **Para exponer** es para preparar la sustentación y no se proyecta. Las cifras son requisitos del enunciado o estimaciones de diseño, nunca resultados de pruebas: hay que decirlo así si preguntan.

Todo sale de [`../propuesta/decisiones-arquitectura.md`](../propuesta/decisiones-arquitectura.md). Si algo de aquí y de allá no coincide, manda ese documento.

---

## 1 · Portada

**En pantalla**

La Gran Liga de Apuestas de Medianos EIA
Salchipapa Maker Racing S.A.S. · Propuesta de arquitectura · Integrantes

- 100.000 usuarios conectados en la final.
- 10.000 apuestas por segundo en los últimos 30 segundos.
- El usuario sabe en menos de 1 segundo si su apuesta fue aceptada.
- Ninguna apuesta aceptada ni ningún movimiento de billetera puede perderse.

**Para exponer:** una frase para situar a todos: se apuesta con EIA Coins, que son créditos del ejercicio, no dinero real. Estas cuatro cifras son el problema; todo lo que sigue es cómo lo resolvemos.

---

## 2 · Qué arquitectura elegimos

**En pantalla**

**Híbrida: una aplicación para el dinero, cinco servicios para lo demás.**

| Opción | Por qué |
|---|---|
| **Híbrida — la elegida** | La apuesta y el descuento se guardan en un solo paso. Lo que no toca el dinero crece y falla por separado |
| Un solo monolito | Si se cae o se actualiza notificaciones, se caen las apuestas. Y para el pico habría que agrandar todo |
| Un servicio por capacidad (diez o más) | Separar billetera de apuestas obliga a reservar saldo y confirmarlo después: más pasos por la red y más formas de fallar |
| Encolar la apuesta y validarla después | No se puede responder "aceptada" en menos de 1 segundo si todavía no se revisó el saldo ni el cierre |

**Para exponer:** la aplicación del dinero contiene apuestas, billetera y pago de premios. Las tres descartadas no son malas arquitecturas: son malas **para este problema**. Si preguntan por "monolito modular": es eso, una sola aplicación bien dividida por dentro, y es justo la parte del dinero.

---

## 3 · Los seis servicios

**En pantalla**

| Servicio | De qué se encarga |
|---|---|
| **Apuestas** | Recibe las apuestas, guarda los EIA Coins y paga los premios |
| **Usuarios** | Registro, inicio de sesión, roles y bloqueos |
| **Carreras** | Carreras, medianos participantes y resultados oficiales |
| **Notificaciones** | Avisos por correo, push y dentro de la app |
| **Estadísticas** | Histórico, reportes premium, cuotas estimadas y fraude |
| **Auditoría** | Registro que no se puede modificar ni borrar |

**API Gateway:** único punto de entrada. Verifica el JWT y limita las peticiones.

**Para exponer:** tres agrupaciones que el enunciado pide justificar. **Medianos** va dentro de Carreras: son decenas de registros que casi nunca cambian y siempre se consultan junto con la carrera. **Resultados** también, porque el resultado es un dato de la carrera. **Premios** va dentro de Apuestas, porque pagar exige leer todas las apuestas y escribir en la billetera. Seis servicios, no veinte: el enunciado penaliza el sobrediseño.

---

## 4 · Diagrama general

**En pantalla**

El diagrama de [`../propuesta/diagrama-general.md`](../propuesta/diagrama-general.md), con su leyenda:

- **Línea continua:** síncrono, alguien espera la respuesta.
- **Línea punteada:** evento en Kafka.
- **Línea gruesa:** tarea en RabbitMQ.

**Frase de apoyo:** «Apuestas y billetera comparten la misma base de datos. Los demás se enteran por eventos.»

**Para exponer:** recorrer el dibujo de izquierda a derecha, que es el orden que pide el enunciado: quién usa la plataforma → API Gateway → servicios → bases de datos → Kafka y RabbitMQ → consumidores. Señalar la caja de borde rojo: ahí está el dinero. Señalar que todo lo punteado y lo grueso puede caerse sin que nadie deje de apostar. La zona pública es solo el API Gateway; lo demás está en red privada.

---

## 5 · Qué pasa cuando alguien aprieta APOSTAR

**En pantalla**

El primer dibujo de [`../propuesta/diagrama-secuencia-apuesta.md`](../propuesta/diagrama-secuencia-apuesta.md), y al lado los pasos:

1. La app manda la apuesta con su JWT y la clave de la operación.
2. El API Gateway verifica el JWT y el límite de peticiones.
3. Apuestas mira si esa clave ya fue atendida.
4. En un solo paso: revisa la carrera, descuenta si el saldo alcanza y guarda la apuesta, el movimiento y los eventos.
5. Recién entonces responde "aceptada".

**Fuera de la respuesta:** los eventos, los avisos, las cuotas y las estadísticas.

**Para exponer:** la idea que hay que dejar clara es que **Apuestas no le pregunta nada a ningún otro servicio** mientras el usuario espera. Mostrar las dos ramas de rechazo: carrera cerrada y saldo insuficiente; en las dos, el saldo queda intacto. Y la rama de la clave repetida, que devuelve la apuesta original.

---

## 6 · Comunicación síncrona: apostar y entrar

**En pantalla**

| De → a | Protocolo | Qué pide | Si no responde |
|---|---|---|---|
| App → API Gateway | REST sobre HTTPS | Todo lo del usuario | La app reintenta con la misma clave |
| API Gateway → Usuarios | REST | Registro e inicio de sesión | Un reintento; las sesiones abiertas siguen |
| API Gateway → Usuarios | REST | Claves públicas para verificar los JWT | Se usa la última copia guardada |
| API Gateway → Apuestas | gRPC | Apostar, saldo, mis apuestas | "Intenta de nuevo". Nunca "aceptada" sin guardar |
| Apuestas → Carreras | gRPC, solo por excepción | Una carrera que no tiene en su copia | **Rechaza la apuesta** |

**Para exponer:** el JWT no se consulta con Usuarios en cada petición: el API Gateway lo verifica con las claves públicas que ya tiene guardadas. Por eso, si Usuarios se cae, quien ya entró sigue apostando. La última fila es la única llamada entre servicios en el camino de una apuesta, y no ocurre en el flujo normal: solo si Apuestas acaba de arrancar o se perdió un evento.

---

## 7 · Comunicación síncrona: consultar y administrar

**En pantalla**

| De → a | Protocolo | Qué pide | Si no responde |
|---|---|---|---|
| API Gateway → Carreras | REST | Carreras y medianos | Un reintento, luego la última copia |
| Carreras → Apuestas | gRPC | Cuánto se ha apostado, para el operador | El último valor, marcado como aproximado |
| API Gateway → Estadísticas | REST | Reportes premium | El reporte del día anterior |
| API Gateway → Auditoría | REST, solo lectura | Historial de una carrera | Se entrega por partes |
| API Gateway → Usuarios / Carreras | REST, red privada | Administración | No se reintenta sola; la repite el operador |
| Notificaciones → Correo y push | HTTPS | Entregar el mensaje | Se reintenta desde RabbitMQ |

**Para exponer:** lo administrativo no está expuesto al público: se llega por red privada y con doble factor. La última fila es síncrona porque la API del proveedor funciona así, pero ocurre **después** de que la apuesta ya fue aceptada: nunca afecta al apostador.

---

## 8 · Los eventos

**En pantalla**

Todos van por **Kafka**. Nombres en español y en pasado: son hechos que ya ocurrieron.

| Evento | Lo publica | Lo leen | Clave |
|---|---|---|---|
| `CarreraAbierta` | Carreras | Apuestas, Notificaciones, Estadísticas | `carreraId` |
| `CarreraCerrada` | Carreras | Apuestas, apps, Estadísticas, Auditoría | `carreraId` |
| `ApuestaAceptada` | Apuestas | Estadísticas, Auditoría, Cuotas, Notificaciones | `carreraId` |
| `ResultadoPublicado` | Carreras | Pago de premios, Notificaciones, Estadísticas, Auditoría | `carreraId` |
| `MovimientoBilleteraRegistrado` | Apuestas | Auditoría, Estadísticas, Notificaciones | `usuarioId` |
| `LiquidacionCalculada` | Pago de premios | Auditoría, Estadísticas | `carreraId` |
| `LiquidacionFinalizada` | Pago de premios | Carreras, Notificaciones, Auditoría | `carreraId` |

**Todo evento lleva:** identificador único, tipo, versión, fecha y los datos del hecho.

**Para exponer:** hay cuatro decisiones que defender. **`CarreraAbierta` es el evento más importante** del sistema: es el que le lleva a Apuestas la hora de cierre y los participantes, y por eso Apuestas puede decidir sola. Fusionamos `CarreraFinalizada` con `ResultadoPublicado`, porque en este negocio la carrera termina justo cuando se registra el resultado. Cambiamos `PremioCalculado` por `LiquidacionCalculada`, uno por carrera y no uno por apuesta: lo otro serían más de un millón de eventos. Y `PremioPagado` quedó absorbido por `MovimientoBilleteraRegistrado`, que lleva el tipo adentro.

Los otros ocho eventos están en la decisión 4 del documento: `CarreraProgramada`, `CarreraIniciada`, `CarreraCancelada`, `ResultadoCorregido`, `ApuestaRechazada`, `CuotasEstimadasActualizadas`, `UsuarioRegistrado` y `UsuarioEstadoCambiado`.

---

## 9 · Cómo quedan Kafka y RabbitMQ

**En pantalla**

**Kafka — hechos que varios leen y se pueden volver a leer**

`Apuestas (tabla de salida) → topic apuestas.aceptadas, 24 particiones, clave carreraId → grupos de Estadísticas, Auditoría, Cuotas y Notificaciones`

Cada grupo lleva su propia posición de lectura.

**RabbitMQ — tareas que se reparten y se reintentan**

`Apuestas → exchange liquidacion (direct) → routing key liquidacion.lote → cola q.liquidacion.lotes → varios procesos de pago`

Reintentos con espera, confirmación manual y cola para los mensajes con problemas.

**Para exponer:** la regla única del equipo: *hecho que le interesa a varios y quiero poder releer → Kafka; tarea que alguien ejecuta y puede fallar → RabbitMQ.* Si preguntan por qué los dos: con solo Kafka habría que programar a mano los reintentos del correo, y un mensaje que no se puede entregar frenaría a los que vienen detrás; con solo RabbitMQ no se puede volver a leer lo ya consumido, que es justo lo que pide el enunciado para la auditoría. Acotamos el costo con un solo clúster de cada uno, los dos administrados. Y si hubiera que elegir uno: Kafka.

Para notificaciones el exchange es `notificaciones`, de tipo topic, con `notif.email.*`, `notif.push.*` y `notif.inapp.*`, una cola por canal. Así un canal caído no afecta a los otros.

---

## 10 · Cuatro clics, una apuesta

**En pantalla**

**500 EIA Coins. Cuatro solicitudes con la misma clave. Un solo descuento.**

El segundo dibujo de [`../propuesta/diagrama-secuencia-apuesta.md`](../propuesta/diagrama-secuencia-apuesta.md).

| Operación | Qué impide que se repita |
|---|---|
| Crear la apuesta | La clave de la operación no se puede repetir para un mismo usuario |
| Descontar el saldo | Cada movimiento lleva su identificador, y se descuenta solo si el saldo alcanza |
| Pagar un premio | El identificador incluye la apuesta y la versión del resultado |
| Recibir un evento repetido | Cada consumidor registra los eventos que ya procesó |

**Para exponer:** el detalle que lo hace funcionar: **la app genera la clave al abrir el formulario**, no al apretar el botón. Si se generara al apretar, cada clic sería una apuesta distinta. La que decide siempre es la base de datos, con una restricción que impide repetir la clave. Si dos clics llegan exactamente a la vez, la base de datos atiende uno y al otro le devuelve la apuesta ya creada. Y Kafka y RabbitMQ pueden entregar el mismo mensaje más de una vez: por eso los consumidores también revisan el identificador del evento.

---

## 11 · Datos y consistencia

**En pantalla**

| Dónde | Qué guarda |
|---|---|
| **Apuestas** | Base relacional propia y dedicada: apuestas, saldos, movimientos y los eventos por publicar |
| **Usuarios, Carreras, Notificaciones** | Una base cada uno, en una máquina compartida al principio |
| **Estadísticas** | Almacén de histórico y una base pensada para reportes |
| **Auditoría** | Almacenamiento que no permite modificar ni borrar, 5 años |

**Consistencia fuerte:** aceptar la apuesta, descontar el saldo, el cierre y el cálculo de los premios.
**Consistencia eventual:** cuotas estimadas, estadísticas, reportes y avisos.

**Para exponer:** ningún servicio lee la base de datos de otro. La pregunta del enunciado —cómo mantener de acuerdo la apuesta y el descuento— tiene respuesta corta: **no están en servicios distintos, justamente para que ese problema no exista**. Por eso no usamos saga en el camino de la apuesta; el enunciado pide esos patrones solo si hacen falta de verdad. Los dos que sí usamos: la tabla de salida, para que el evento se guarde junto con la apuesta, y el registro de eventos ya procesados, porque los mensajes pueden llegar repetidos.

---

## 12 · Los últimos 30 segundos

**En pantalla**

**300.000 apuestas en 30 segundos, respondiendo en menos de 1 segundo, sin perder ninguna.**

- **Antes:** la capacidad se prepara media hora antes. El calendario de carreras se conoce.
- **El atasco menos obvio:** no llevamos el total apostado mientras la carrera está abierta; las cuotas en vivo se calculan aparte, leyendo las apuestas de Kafka.
- **El cierre lo decide el reloj de la base de datos**, no el de cada copia del servicio.
- **El saldo nunca queda negativo:** se descuenta solo si alcanza.
- **Después:** los premios se pagan en lotes de 1.000 apuestas. Meta: menos de 15 minutos.

**Para exponer:** si cada apuesta sumara al total de la carrera, las 10.000 por segundo escribirían sobre el mismo dato y pasarían de a una: ese es el cuello de botella más grave y el menos evidente. La base de datos de Apuestas es lo único del camino que no se resuelve agregando copias: se agranda la máquina. Y si se satura, rechazamos rápido y lo decimos, en vez de acumular peticiones adentro. Las cifras son requisitos de diseño: el siguiente paso real sería medirlas con carga.

---

## 13 · Seguridad

**En pantalla**

| Acceso | Qué hay ahí |
|---|---|
| **Público** | El API Gateway y el filtro de tráfico. Nada más |
| **Privado** | Los seis servicios, las bases de datos, Kafka, RabbitMQ y el almacenamiento |
| **Administración** | Red privada, doble factor y permisos por rol |

- JWT de corta duración, y cada servicio revisa además **sobre qué dato** se opera.
- Cuatro roles: apostador, operador, administrador y auditor. El auditor solo lee.
- Cifrado en tránsito y en reposo. Las credenciales nunca en el código.
- Límites de peticiones por usuario, y detección de bots y de cuentas que comparten dispositivo.
- Toda acción de administración queda registrada. Corregir un resultado exige dos personas.

**Para exponer:** el identificador del usuario se toma siempre del JWT, nunca de lo que manda la app: es lo que impide que alguien consulte la billetera de otro. Para bloquear a alguien al instante, el API Gateway consulta una lista de sesiones revocadas, que compensa que el JWT dure unos minutos. Y el registro de auditoría no lo puede alterar nadie, ni los administradores: esa es la diferencia entre una garantía y una promesa.

---

## 14 · Costos

**En pantalla**

| Decisión | Por qué ahorra |
|---|---|
| Seis servicios, no veinte | Cada servicio extra cuesta base de datos, despliegue, monitoreo y atención |
| Preparar la capacidad según el calendario | El pico se paga unas horas al mes, no todo el mes |
| Los procesos de pago solo existen mientras trabajan | Son unos diez minutos después de cada carrera |
| Una máquina compartida para las bases pequeñas | Tres máquinas pequeñas cuestan casi el triple que una mediana |
| Todo administrado por el proveedor | El costo real de esto es el equipo que lo mantiene, no las máquinas |
| El histórico, en almacenamiento barato | En la base de datos solo se quedan 90 días |

**Para exponer:** la frase de Dyllan es "no quiero pagar una infraestructura de Netflix para una carrera de cinco medianos". La decisión que más ahorra es la del calendario: los picos no son sorpresa. Si preguntan cifras: el orden de magnitud es de unos pocos miles de dólares al mes, más unas decenas por evento grande. Es una estimación para ubicar la escala, no una cotización; depende del proveedor y de la región.

---

## 15 · Qué pasa cuando algo se cae

**En pantalla**

| Se cae | ¿Se puede apostar? |
|---|---|
| **Notificaciones** | **Sí.** Los avisos esperan en Kafka y salen después |
| **Apuestas o la billetera** | **No.** Sin poder descontar, no se acepta ninguna apuesta |
| **Kafka** | **Sí.** Los eventos esperan en la tabla de salida |
| **RabbitMQ** | **Sí.** Se atrasan los premios y los avisos; nada se pierde |
| **Carreras** | **Sí**, para las carreras ya abiertas |
| **Usuarios** | **Sí**, para quien ya tiene su sesión |

**Para exponer:** las dos primeras filas son los casos A y B del enunciado, y la diferencia es de fondo: *se puede degradar lo que informa; no se puede degradar lo que decide sobre el dinero*. Aceptar una apuesta sin descontarla crea una deuda sin respaldo, y eso no se arregla después. Además, como la billetera vive dentro de Apuestas, el estado peligroso "se puede apostar pero no descontar" **no existe por diseño**.

**Caso C, si lo preguntan:** el resultado estaba mal y ya se pagaron premios. Nada se borra: se guarda una versión 2 del resultado, se anotan las reversiones de los premios mal pagados, se pagan los correctos y se avisa a los dos afectados. Lo autoriza un operador y lo aprueba un administrador distinto. Para que pase lo menos posible, proponemos esperar dos minutos entre publicar el resultado y empezar a pagar.

---

## 16 · ADR-001 · Arquitectura híbrida

**En pantalla**

**Contexto:** el pico es exigente, el dinero no admite errores y el equipo es pequeño.

**Opciones:** un solo monolito · un servicio por capacidad · encolar y validar después · híbrida.

**Decisión:** una aplicación con apuestas, billetera y premios; cinco servicios alrededor, detrás de un API Gateway.

**Se gana:** el dinero queda consistente sin coordinar servicios; crece solo lo que lo necesita; una caída de notificaciones, estadísticas o auditoría no afecta a nadie.

**Se pierde:** si Apuestas se cae, no hay apuestas; su base de datos concentra la escritura; y exige disciplina para que las partes internas no se mezclen.

**Para exponer:** estado, aceptada. Una diapositiva equivale a la página que pide el enunciado.

---

## 17 · ADR-002 · La apuesta y el descuento, en un solo paso

**En pantalla**

**Contexto:** nadie puede gastar dos veces sus EIA Coins, ninguna apuesta aceptada se puede perder, hay que responder en menos de 1 segundo y la gente reintenta.

**Opciones:** reservar saldo y confirmar después · descontar más tarde · guardar la billetera como lista de movimientos · un solo paso en la misma base de datos.

**Decisión:** la apuesta, el movimiento, el saldo y los eventos se guardan todos juntos o ninguno.

**Se gana:** es imposible gastar dos veces o quedar en negativo; los reintentos no cobran de nuevo; el caso B deja de ser un dilema.

**Se pierde:** apuestas y billetera no se despliegan ni crecen por separado, y comparten su suerte si hay una falla.

**Para exponer:** es la decisión de la que se derivan casi todas las demás. Si preguntan por saga: queda documentada como paso de crecimiento, para cuando haga falta de verdad.

---

## 18 · ADR-003 · Kafka para los hechos, RabbitMQ para las tareas

**En pantalla**

**Contexto:** los mismos hechos le interesan a cuatro consumidores y hay que poder releerlos; además hay millones de pagos que repartir y avisos que reintentar.

**Opciones:** solo Kafka · solo RabbitMQ · ninguno, todo con llamadas directas · los dos con una frontera estricta.

**Decisión:** Kafka lleva los hechos; RabbitMQ lleva las tareas.

**Se gana:** historial y relectura para auditoría y estadísticas; reintentos por mensaje sin frenar la cola; más procesos de pago sin reconfigurar nada.

**Se pierde:** dos tecnologías que aprender, vigilar y pagar.

**Para exponer:** estado, aceptada. El plan de salida está escrito: si estorba, se quita RabbitMQ y se conserva Kafka.

---

## 19 · Qué haríamos hoy y cómo creceríamos cien veces

**En pantalla**

**Hoy:** la arquitectura de esta presentación, sobre servicios administrados, con la capacidad preparada según el calendario de carreras.

| Cuando pase esto | Haríamos esto |
|---|---|
| Las apuestas tardan más de lo aceptable | Agrandar la máquina, más copias de lectura, más particiones |
| El pago de premios se acerca a los 15 minutos | Separarlo a su propia máquina y, después, a su propio servicio |
| Más de 50.000 apuestas por segundo sostenidas | Separar la billetera, con reserva de saldo |
| La máquina ya no se puede agrandar | Repartir los datos en varias bases, por carrera y por usuario |

**Para exponer:** lo importante no es la lista, sino que **ningún paso exige rediseñar**: cada uno separa algo por una línea que ya existe hoy. Las claves con que hoy repartimos los eventos son las mismas con que mañana se dividirían los datos. Y cien veces el pico es un millón de apuestas por segundo: es un camino, no algo que este documento demuestre; cada paso habría que medirlo antes de darlo.

Conectar con los siete criterios que pide el enunciado: complejidad, escalabilidad, resiliencia, consistencia, seguridad, costo y mantenibilidad.

---

## 20 · Conclusiones

**En pantalla**

- La apuesta y el descuento se confirman juntos, o no se confirma ninguno.
- Cuatro clics siguen siendo una sola apuesta.
- Notificaciones, estadísticas y auditoría pueden atrasarse sin frenar a nadie.
- La capacidad se prepara con el calendario; el gasto sigue a la carga.

**Cierre:** «El problema no era de tamaño, era de exactitud. Por eso la arquitectura está organizada alrededor del dinero y no alrededor del tráfico.»

**Para exponer:** el siguiente paso honesto es probarlo: el pico de apuestas, los reintentos al mismo tiempo y una falla a mitad del pago de premios.

**Si piden apuestas en vivo durante la carrera** —el enunciado avisa que habrá un cambio de requisitos—: la carrera pasa de tener una hora de cierre a tener varias ventanas, cada una con la suya; la bolsa y el pago se calculan por ventana; las cuotas se actualizan más seguido; y el módulo de fraude gana una regla para suspender las apuestas cuando pasa algo relevante en la pista. **Nada de eso toca la parte del dinero:** la apuesta en vivo sigue siendo un solo paso con descuento condicionado y clave de operación. Cambia el modelo del negocio, no la arquitectura.

---

## Cobertura de lo que pide el enunciado

| Requisito | Diapositiva |
|---|---|
| Estilo arquitectónico y alternativas descartadas | 2 |
| Servicios y responsabilidades | 3 |
| Diagrama general | 4 |
| Diagrama de secuencia de una apuesta | 5 y 10 |
| Tabla de comunicaciones síncronas | 6 y 7 |
| Eventos y comunicación asíncrona | 8 |
| Diseño de Kafka y RabbitMQ | 9 |
| Idempotencia | 10 |
| Datos y consistencia | 11 |
| Cargas masivas | 12 |
| Seguridad, público y privado | 13 |
| Costos | 14 |
| Manejo de fallos | 15 |
| Tres ADR, máximo una página cada uno | 16, 17 y 18 |
| Pregunta final | 19 |
| Conclusiones | 20 |

Veinte diapositivas, portada incluida. Las notas no son diapositivas. Cada integrante debe poder explicar cualquiera de estas decisiones y responder al cambio de requisitos.

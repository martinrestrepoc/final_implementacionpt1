# Trabajo de Arquitectura de Software — La Gran Liga de Apuestas de Medianos EIA

> Documento de contexto generado a partir de `final pt1.pdf`, para consulta legible por IA y por el equipo. Contiene **todos los detalles** del enunciado original: historia/contexto, reglas de negocio, capacidades del sistema, supuestos de diseño, decisiones obligatorias, entregables, criterios de evaluación y restricciones.

---

## 1. Contexto narrativo (historia del enunciado)

Hace varios años, detrás de los laboratorios de la Universidad EIA, vivía pacíficamente una pequeña comunidad de **medianos** (hobbits). Llevaban una vida tranquila: comían siete veces al día, evitaban las clases de las 6:00 a.m. y discutían sobre cuál cafetería de la universidad vendía el mejor almuerzo.

Todo cambió cuando apareció **Dyllan, el gigante de Salchipapa Maker**. Obsesionado con encontrar nuevos participantes para sus experimentos deportivos, Dyllan capturó a los medianos y creó la primera **Liga Profesional de Carreras de Medianos de la Universidad EIA**.

Las carreras se volvieron populares. Profesores, estudiantes, administrativos y misteriosos personajes externos comenzaron a apostar créditos ficticios llamados **EIA Coins** sobre cuál mediano ganaría cada carrera.

> **Nota del enunciado:** los EIA Coins son créditos ficticios de este ejercicio: no tienen valor monetario, no se compran ni se canjean. El ejercicio no promueve apuestas con dinero real.

Lo que comenzó como una hoja de cálculo manejada por Dyllan se convirtió en un negocio inesperadamente grande: ahora existen miles de usuarios, cientos de carreras, estadísticas históricas, apuestas en tiempo real y transmisiones en vivo. Dyllan necesita una plataforma tecnológica profesional, pero él "sabe hacer salchipapas, no diseñar sistemas distribuidos". Su equipo (= el grupo de estudiantes) deberá hacerlo por él.

Ejemplos de medianos competidores (nombres de sabor "Tolkien + F1"):
- Frodito Turbo
- Bilbo Rápido
- Samwise Verstappen
- Peregrin Hamilton
- Merry Alonso

---

## 2. El reto (encargo formal)

La empresa **Salchipapa Maker Racing S.A.S.** contrata al equipo como **arquitectos de software**. La misión es **diseñar la arquitectura tecnológica** de la plataforma de apuestas de carreras de medianos.

**NO se debe implementar la solución.** El objetivo es analizar el problema y tomar decisiones arquitectónicas justificadas.

El equipo debe decidir, entre otras cosas:
- Si la solución debe construirse como un **monolito**.
- Si debe utilizar una arquitectura de **microservicios**.
- Si sería conveniente una arquitectura **híbrida**.
- Qué operaciones deberían comunicarse de manera **síncrona**.
- Qué operaciones deberían funcionar mediante **eventos** (asíncronas).
- Cuándo utilizar **RabbitMQ**.
- Cuándo utilizar **Kafka**.
- Cómo soportar grandes cantidades de información.
- Cómo evitar operaciones duplicadas mediante **idempotencia**.
- Cómo mantener consistentes los datos entre componentes.
- Cómo mantener la plataforma segura.
- Cómo evitar que la infraestructura cueste más que todos los medianos juntos (tema de **costos**).

---

## 3. Funcionamiento del negocio

Cada semana se realizan diferentes carreras.

### Una carrera tiene:
- identificador
- fecha y hora
- pista
- distancia
- medianos participantes
- estado
- resultados
- ganador

Los usuarios pueden consultar las carreras disponibles y realizar apuestas utilizando EIA Coins.

### Una apuesta contiene:
- usuario
- carrera
- mediano seleccionado
- cantidad apostada
- fecha
- identificador único de la operación

Cuando termina una carrera, el sistema recibe los resultados oficiales y determina cuáles apuestas fueron ganadoras. Posteriormente se acreditan automáticamente las recompensas a las billeteras virtuales de los usuarios.

### Reglas del negocio (supuestos fijos para todos los equipos)

- **Modelo de premios (apuesta mutua / pari-mutuel):** todas las apuestas de una carrera forman una bolsa común. La casa retiene una **comisión del 10 %** y el resto se reparte entre las apuestas ganadoras, en proporción al monto apostado. El premio final solo se conoce cuando se cierran las apuestas.
- **Cuotas estimadas:** mientras la carrera está abierta, la plataforma muestra una cuota aproximada por mediano, que cambia a medida que llegan apuestas.
- **Cierre de apuestas:** las apuestas se cierran **exactamente a la hora de inicio de la carrera**, según el reloj del servidor. Una apuesta que llegue después del cierre debe rechazarse, aunque el usuario la haya enviado antes.
- **Varias apuestas:** un usuario puede realizar varias apuestas en la misma carrera, incluso sobre medianos distintos.
- **Cancelación:** si una carrera se cancela, se devuelve el 100 % de lo apostado a cada usuario.

### Ciclo de vida de una carrera

```
PROGRAMADA → ABIERTA → CERRADA → EN_CURSO → FINALIZADA → LIQUIDADA
```

Una carrera puede pasar a **CANCELADA** desde cualquier estado anterior a FINALIZADA.

---

## 4. Capacidades principales del sistema

### 4.1 Usuarios y autenticación
Debe permitir:
- registrar usuarios
- iniciar sesión
- consultar perfiles
- administrar roles
- bloquear usuarios
- validar permisos

Roles existentes:
- apostador
- operador de carrera
- administrador
- auditor

La información sensible (contraseñas, datos personales, movimientos de billetera) debe estar protegida.

### 4.2 Medianos
Debe almacenar la información de cada competidor:
- nombre
- edad
- peso
- historial de carreras
- victorias
- derrotas
- velocidad promedio
- estado actual

> El enunciado pide explícitamente decidir si esta capacidad **merece un servicio independiente** o puede formar parte de otro componente.

### 4.3 Carreras
Administra:
- creación de carreras
- programación
- participantes
- horarios
- pistas
- inicio de carrera
- finalización
- resultados oficiales

Cuando una carrera comienza o termina, otros componentes podrían necesitar conocer inmediatamente esta información. **El equipo debe decidir cómo comunicar estos cambios** (síncrono vs. eventos).

### 4.4 Apuestas
Permite realizar apuestas sobre carreras disponibles. Antes de aceptar una apuesta debe comprobarse:
- que el usuario exista
- que la carrera esté abierta a apuestas (antes del cierre)
- que el mediano participe en la carrera
- que el usuario tenga suficientes EIA Coins
- que la apuesta no esté duplicada

> Durante carreras importantes se esperan **miles de apuestas por segundo**. Es uno de los puntos más críticos de la arquitectura.

### 4.5 Billetera de EIA Coins
Cada usuario tiene una billetera virtual. Debe permitir:
- consultar saldo
- descontar EIA Coins al realizar una apuesta
- acreditar premios
- consultar movimientos
- realizar devoluciones cuando una carrera sea cancelada

> **Nunca debe ser posible gastar dos veces los mismos EIA Coins** (doble gasto / double-spend).

### 4.6 Resultados y premios
Cuando termina una carrera se recibe el resultado oficial. El sistema debe:
1. identificar el ganador
2. encontrar las apuestas ganadoras
3. calcular los premios
4. acreditar los EIA Coins
5. registrar cada movimiento
6. generar información para auditoría

> Una carrera popular podría acumular **más de un millón de apuestas**. No conviene procesarlas todas mediante una única petición HTTP (implica procesamiento asíncrono/batch).

### 4.7 Notificaciones
Los usuarios reciben mensajes cuando:
- una apuesta fue aceptada
- comenzó una carrera
- terminó una carrera
- ganaron una apuesta
- recibieron EIA Coins
- una carrera fue cancelada

Canales: correo electrónico, aplicación móvil, notificaciones push.

> **Una falla en el sistema de notificaciones no debería impedir que una apuesta sea registrada** (requisito de desacoplamiento/tolerancia a fallos).

### 4.8 Estadísticas y analítica
Dyllan quiere vender estadísticas premium sobre los medianos. El sistema debe almacenar:
- número de apuestas
- montos apostados
- comportamiento de usuarios
- carreras realizadas
- rendimiento histórico de los medianos
- probabilidades
- tendencias
- eventos generados por la plataforma

> Cada día podrían producirse **millones de registros**. El sistema de analítica **no necesita conocer toda la información en tiempo real** (consistencia eventual aceptable).

### 4.9 Auditoría y control de fraude
Toda operación que afecte saldos, apuestas o resultados debe quedar registrada. El sistema debe permitir:
- conservar un registro **inalterable** de apuestas, movimientos de billetera, premios y cambios de resultados
- consultar ese registro con el rol **auditor** (solo lectura)
- detectar comportamientos sospechosos (muchas cuentas apostando desde el mismo dispositivo, apuestas masivas segundos antes del cierre)
- reconstruir, para cualquier carrera, cómo se calcularon sus premios

---

## 5. El problema de las cargas masivas

La popularidad de una carrera puede cambiar drásticamente:
- Carrera normal: **500 usuarios conectados**.
- Final de la **Copa Intersemestral Dyllan Salchipapa Maker**: **100.000 usuarios conectados simultáneamente**.

Durante los últimos segundos antes del cierre de apuestas pueden llegar miles de solicitudes prácticamente al mismo tiempo.

La arquitectura debe explicar:
- qué componentes deberían poder escalar
- cuáles no necesitan escalar de la misma manera
- cómo absorberían picos de tráfico
- cómo evitarían perder operaciones
- qué sucedería si un servicio está temporalmente caído

---

## 6. Supuestos de diseño (fijos; se pueden ajustar solo si se justifica explícitamente)

| Aspecto | Supuesto |
|---|---|
| Usuarios concurrentes | 500 en una carrera normal; 100.000 en la final de la Copa Intersemestral |
| Pico de apuestas | 10.000 apuestas/segundo durante los 30 segundos previos al cierre |
| Respuesta al apostar | El usuario debe saber en **menos de 1 segundo** si su apuesta fue aceptada o rechazada |
| Pérdida de datos | **Ninguna** apuesta aceptada ni movimiento de billetera puede perderse |
| Liquidación de premios | Todos los premios pagados en **menos de 15 minutos** después del resultado oficial |
| Estadísticas | Pueden tener minutos de retraso; reportes premium, hasta un día |
| Auditoría | Los registros se conservan **al menos 5 años** |

---

## 7. Idempotencia: "Dyllan no quiere pagar dos veces"

**Caso guía del enunciado:** un estudiante apuesta 500 EIA Coins. La app demora en responder. El estudiante presiona APOSTAR de nuevo, y otra vez, y una cuarta vez "porque presionar más fuerte hace que Internet funcione mejor". El sistema recibe **cuatro solicitudes** para la misma operación lógica.

**Requisito:** el diseño debe garantizar que esa operación lógica no sea procesada cuatro veces. Hay que explicar cómo se usarían mecanismos de idempotencia, considerando (no es obligatorio implementarlos, sí explicar dónde y por qué):
- identificadores únicos de operación
- idempotency keys
- almacenamiento de operaciones procesadas
- restricciones únicas en bases de datos
- identificadores únicos de eventos

---

## 8. Comunicación entre componentes

### 8.1 Comunicación síncrona
Ejemplos: HTTP/REST, gRPC. Tiene sentido cuando un servicio necesita conocer inmediatamente la respuesta de otro.

### 8.2 Comunicación asíncrona
Mediante eventos/mensajes para operaciones que no necesitan completarse en la misma petición. Eventos sugeridos (el equipo decide cuáles deberían existir, y puede fusionar/eliminar/agregar):
- `ApuestaRealizada`
- `CarreraIniciada`
- `CarreraFinalizada`
- `ResultadoPublicado`
- `PremioCalculado`
- `PremioPagado`
- `CarreraCancelada`

> Deben usar **un único idioma** para nombrar eventos (p. ej. `ApuestaRealizada` o `BetPlaced`, pero no mezclar).

### 8.3 RabbitMQ vs. Kafka

**RabbitMQ** — útil para:
- distribuir tareas
- utilizar colas
- procesar trabajos mediante diferentes consumidores
- implementar reintentos
- gestionar mensajes pendientes

Ejemplo conceptual:
```
Carrera termina
    ↓
Cola de cálculo de premios
    ↓
Workers
    ↓
Procesamiento de apuestas
```

**Kafka** — útil cuando existen:
- grandes volúmenes de eventos
- múltiples consumidores interesados en la misma información
- necesidad de almacenar el historial de eventos
- procesamiento de streams
- analítica
- necesidad de reproducir eventos posteriormente

Ejemplo conceptual:
```
ApuestaRealizada
    ↓
   Kafka
    ↓
Analítica · Fraude · Estadísticas · Auditoría
```
(Cada consumidor lee el mismo evento de forma independiente y a su propio ritmo.)

> No hay obligación de usar ambos. El equipo decide: **RabbitMQ, Kafka, ambos o ninguno**, con argumentación técnica.

---

## 9. Seguridad

La plataforma maneja dinero virtual y operaciones que afectan saldos. El diseño debe considerar como mínimo:
- autenticación
- autorización
- roles
- protección de APIs
- cifrado de comunicaciones
- manejo seguro de credenciales
- protección de operaciones administrativas
- limitación de tasa (rate limiting) y protección contra bots
- registro de todas las acciones administrativas

También hay que indicar qué componentes deberían ser **públicos** y cuáles deberían permanecer en una **red privada**.

---

## 10. Costos

Regla de Dyllan: *"No quiero pagar una infraestructura de Netflix para una carrera de cinco medianos."*

No siempre dividir en veinte microservicios es mejor arquitectura. El equipo debe justificar:
- cuántos servicios necesita realmente
- cuáles componentes pueden compartir infraestructura
- cuáles componentes deben escalar independientemente
- dónde sería razonable usar servicios administrados (managed services)
- cómo evitar infraestructura innecesaria

---

## 11. Decisiones obligatorias (deben responderse explícitamente)

### Decisión 1 — Estilo arquitectónico
¿Monolito, monolito modular, microservicios o arquitectura híbrida? ¿Por qué? Mencionar **al menos dos alternativas descartadas** y la razón de descartarlas.

### Decisión 2 — División de servicios
Definir los componentes/servicios principales. Capacidades de referencia: usuarios, medianos, carreras, apuestas, billetera, resultados, premios, notificaciones, estadísticas, auditoría. No necesariamente cada capacidad = un microservicio; decidir cuáles separar y cuáles mantener juntas.

### Decisión 3 — Comunicación síncrona
Indicar qué componentes se comunican directamente vía REST o gRPC. Completar tabla:

| Servicio origen | Servicio destino | Protocolo | Información solicitada | ¿Por qué debe ser síncrona? |
|---|---|---|---|---|
| | | | | |

Indicar también qué ocurre si el destino no responde a tiempo (timeout, reintento o respuesta alternativa).

### Decisión 4 — Comunicación asíncrona
Definir los eventos principales (partiendo de los sugeridos, pudiendo agregar/fusionar/eliminar), con **un único idioma** de nombres. Completar tabla:

| Evento | Productor | RabbitMQ / Kafka | Consumidor o consumidores | Clave de partición o routing key |
|---|---|---|---|---|
| | | | | |

Indicar la información mínima que contiene cada evento (p. ej. id del evento, fecha, datos del negocio).

### Decisión 5 — RabbitMQ vs. Kafka
Explicar cuál utilizarían, dónde, por qué y qué problema resuelve. Si usan ambos, justificar por qué la ventaja de mantener dos tecnologías compensa la complejidad adicional.

### Decisión 6 — Idempotencia
Identificar **al menos tres operaciones** con riesgo de duplicación (p. ej. crear una apuesta, cobrar una apuesta, pagar un premio, procesar un evento recibido más de una vez) y explicar cómo evitarían procesarlas múltiples veces. Tener en cuenta que RabbitMQ y Kafka pueden entregar el mismo mensaje más de una vez (at-least-once); los consumidores deben tolerarlo.

### Decisión 7 — Grandes volúmenes
Explicar cómo respondería la arquitectura ante 10.000 apuestas/segundo durante los 30 segundos previos al cierre. Identificar:
- posibles cuellos de botella
- componentes que deberían escalar
- uso de colas o streams
- mecanismos para no perder información
- cómo garantizar que ninguna apuesta sea aceptada después del cierre
- cómo evitar que el saldo de un usuario quede negativo al enviar varias apuestas en paralelo

### Decisión 8 — Fallos
Analizar al menos dos situaciones:

- **Caso A:** el sistema de notificaciones está caído. ¿Los usuarios deberían poder seguir apostando?
- **Caso B:** el servicio de billetera está caído. ¿Los usuarios deberían poder seguir apostando? (Explicar por qué las respuestas a A y B podrían ser diferentes.)
- **Caso C (opcional):** diez minutos después de publicado el resultado oficial, un operador descubre que la foto de llegada fue mal interpretada y el ganador era otro mediano; algunos premios ya fueron pagados. ¿Cómo corregirían el resultado sin perder la trazabilidad de lo ocurrido?

### Decisión 9 — Datos y consistencia
Explicar:
- qué tipo de base de datos usaría cada servicio/módulo y si la comparten o no
- qué datos requieren consistencia fuerte y cuáles pueden ser eventualmente consistentes
- cómo mantendrían coherentes la apuesta registrada y el descuento en la billetera si están en componentes distintos
- dónde almacenarían el histórico de eventos y los datos para analítica

Pueden considerar patrones como transacciones locales, sagas o transactional outbox, **solo si realmente los necesitan**.

---

## 12. Diseño de la arquitectura (entregables gráficos)

### 12.1 Diagrama general de arquitectura
Herramientas sugeridas: Draw.io, Lucidchart, Excalidraw, Mermaid, PowerPoint, o similar.

Debe mostrar claramente el flujo:
```
Cliente
  ↓
API / Gateway
  ↓
Servicios o módulos
  ↓
Bases de datos
  ↓
RabbitMQ / Kafka
  ↓
Consumidores
```

Deben **diferenciar visualmente** comunicación síncrona vs. asíncrona.

### 12.2 Diagrama de secuencia
Del flujo completo de una apuesta: desde que el usuario presiona **APOSTAR** hasta que recibe la confirmación, incluyendo el descuento en la billetera.

### 12.3 Diseño obligatorio de la mensajería
Si usan **RabbitMQ**, mostrar: Exchange, Queue, Producer, Consumer, Routing.

Si usan **Kafka**, mostrar: Producer, Topic, Partitions, Consumer Groups, Consumers.

> No es necesario configurar ni ejecutar RabbitMQ o Kafka — únicamente diseñar la solución.

---

## 13. Entregable final (contenido obligatorio del documento/presentación)

1. Arquitectura seleccionada y justificación (monolito, monolito modular, microservicios o híbrida), incluyendo alternativas descartadas.
2. Identificación de servicios o módulos y sus responsabilidades.
3. Diagrama general de arquitectura.
4. Diagrama de secuencia del flujo de una apuesta.
5. Comunicaciones síncronas (tabla de la Decisión 3).
6. Eventos y comunicaciones asíncronas (tabla de la Decisión 4).
7. Diseño de RabbitMQ y/o Kafka.
8. Estrategia de idempotencia.
9. Datos y consistencia.
10. Manejo de cargas masivas.
11. Estrategia básica de seguridad, indicando qué componentes son públicos y cuáles privados.
12. Consideraciones de costo.
13. Manejo de fallos.
14. Registros de decisiones arquitectónicas (**ADR**) para las **tres decisiones más importantes**.
15. Respuesta a la pregunta final (ver sección 15).
16. Conclusiones.

### Formato de cada ADR
Cada ADR debe ocupar **como máximo una página** e incluir:
- contexto
- opciones consideradas
- decisión tomada
- consecuencias (lo que se gana y lo que se sacrifica)

---

## 14. Condiciones y evaluación

- **Grupos:** máximo 3 estudiantes.
- **Fecha de entrega:** exposición **4 y 5 de noviembre**.
- **Extensión:** presentación de **máximo 20 diapositivas**.
- **Uso de IA:** permitido usar herramientas de IA generativa, pero todo lo entregado debe poder ser **explicado y defendido por cualquier integrante del grupo**.
- **Sustentación:** cada grupo presenta su arquitectura. Durante la sustentación se planteará un **cambio de requisitos** (por ejemplo, permitir apuestas en vivo mientras la carrera está en curso) y el equipo deberá explicar cómo lo absorbería su diseño.

### Criterios de evaluación

| Criterio | Peso |
|---|---|
| Justificación del estilo arquitectónico y de la división en servicios | 15 % |
| Comunicación síncrona, asíncrona y diseño de la mensajería | 20 % |
| Idempotencia, datos y consistencia | 20 % |
| Escalabilidad y manejo de fallos | 15 % |
| Seguridad y costos | 10 % |
| Calidad de los diagramas, los ADR y el documento | 10 % |
| Sustentación | 10 % |

---

## 15. Restricción importante

**NO SE DEBE IMPLEMENTAR LA ARQUITECTURA.**

El trabajo busca evaluar la capacidad de **analizar, diseñar, argumentar y tomar decisiones arquitectónicas**. No se calificará quién tenga más microservicios.

De hecho, el enunciado advierte explícitamente (en tono humorístico) que crear:
- 42 microservicios
- 17 bases de datos
- 6 clusters de Kafka
- 4 clusters de RabbitMQ
- 3 clusters de Kubernetes

para administrar cinco medianos probablemente sea una excelente manera de conseguir que Dyllan despida al equipo. Es decir: **el sobrediseño se penaliza**; se busca la complejidad justa, no la máxima.

---

## 16. Pregunta final (obligatoria de responder)

> **Si ustedes fueran los responsables técnicos de Salchipapa Maker Racing S.A.S., ¿qué arquitectura implementarían hoy y cómo permitirían que evolucionara si la plataforma creciera 100 veces?**

La respuesta debe estar sustentada en decisiones relacionadas con:
- complejidad
- escalabilidad
- resiliencia
- consistencia
- seguridad
- costo
- mantenibilidad

---

## 17. Idea central del trabajo

> Una buena arquitectura no es aquella que utiliza más tecnologías. Una buena arquitectura es aquella que utiliza **la complejidad necesaria para resolver el problema sin agregar complejidad innecesaria**.
>
> Y, sobre todo: **ningún mediano debe recibir dos premios porque alguien presionó cuatro veces el botón** (es decir: la idempotencia es un requisito central y recurrente de todo el ejercicio).

---

## 18. Checklist rápido de lo que el entregable debe cubrir

- [ ] Decisión de estilo arquitectónico justificada + 2 alternativas descartadas
- [ ] Lista de servicios/módulos con responsabilidades claras
- [ ] Diagrama general (Cliente → Gateway → Servicios → BD → Broker → Consumidores), diferenciando sync/async
- [ ] Diagrama de secuencia del flujo "Apostar"
- [ ] Tabla de comunicaciones síncronas (origen, destino, protocolo, info, por qué síncrona, manejo de timeout)
- [ ] Tabla de eventos asíncronos (evento, productor, broker, consumidores, routing/partition key, payload mínimo)
- [ ] Diseño de mensajería (Exchange/Queue/Routing si RabbitMQ; Topic/Partitions/Consumer Groups si Kafka)
- [ ] Estrategia de idempotencia con ≥3 operaciones críticas identificadas
- [ ] Estrategia de datos y consistencia (BD por servicio, fuerte vs. eventual, coherencia apuesta-billetera, almacenamiento de eventos/analítica)
- [ ] Manejo de picos de 10.000 apuestas/seg (cuellos de botella, escalado, colas/streams, no pérdida de datos, cierre exacto, no saldo negativo)
- [ ] Seguridad: autenticación, autorización, roles, APIs, cifrado, credenciales, rate limiting, auditoría de acciones admin, público vs. privado
- [ ] Consideraciones de costo (número real de servicios, infraestructura compartida, escalado independiente, servicios administrados)
- [ ] Manejo de fallos: Caso A (notificaciones caídas), Caso B (billetera caída), Caso C opcional (corrección de resultado post-pago)
- [ ] 3 ADR (máx. 1 página c/u: contexto, opciones, decisión, consecuencias)
- [ ] Respuesta a la pregunta final (arquitectura hoy + evolución a 100x)
- [ ] Conclusiones
- [ ] Presentación ≤ 20 diapositivas, lista para sustentación con posible cambio de requisitos en vivo (ej. apuestas en vivo durante la carrera)

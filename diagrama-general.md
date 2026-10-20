# Diagrama general de arquitectura — Plataforma de Apuestas "La Gran Liga de Medianos EIA"

> Derivado de `decisiones-arquitectura.md` (Anexo A.1). Cubre el entregable 12.1 del enunciado:
> flujo **Cliente → API/Gateway → Servicios → Bases de datos → Kafka/RabbitMQ → Consumidores**, con **distinción visual entre comunicación síncrona y asíncrona**.

## Convención visual (obligatoria para la sustentación)

| Trazo / color | Significado |
|---|---|
| ──────► línea continua | **Síncrono** — HTTPS/REST o gRPC. El origen espera la respuesta |
| ╌╌╌╌╌► línea discontinua | **Asíncrono — evento de dominio** en **Kafka** (hecho en pasado, multi-consumidor, releíble) |
| ══════► línea gruesa | **Asíncrono — comando** en **RabbitMQ** (tarea a ejecutar, con reintentos y DLQ) |
| Caja roja de borde grueso | **Núcleo transaccional**: aquí vive el dinero y la única transacción ACID del camino crítico |
| Zona amarilla | **Público (Internet)** |
| Zonas azul · verde · violeta · celeste | **Red privada**, sin IP pública |

Las etiquetas usan códigos cortos (`S1`…`S10` para lo síncrono, nombres de evento y `cg-*` para lo asíncrono). El detalle completo de cada arista está en la **§5**, para que los diagramas quepan en una diapositiva sin perder información.

**Se entregan tres vistas del mismo sistema**, porque un único diagrama con las 45 aristas resulta ilegible al proyectarlo:

| Vista | Para qué sirve | Diapositiva sugerida |
|---|---|---|
| **1. Integrada** (§1) | El diagrama general: las 7 zonas, los 6 servicios, las bases de datos, los dos brokers y los consumidores, con los tres tipos de trazo | La que acompaña la explicación de la arquitectura |
| **2. Camino crítico síncrono** (§2) | Demuestra que apostar no cruza ninguna frontera de red entre servicios y que se cumple el SLA de <1 s | La que acompaña "cómo se acepta una apuesta" |
| **3. Flujo asíncrono** (§3) | Demuestra el desacoplamiento: quién publica, qué broker y qué consumer group lee cada evento | La que acompaña "eventos y mensajería" |

---

## 1. Vista integrada — el diagrama general

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 25, 'rankSpacing': 60, 'curve': 'basis'}}}%%
flowchart TB
  subgraph Z1["CLIENTES"]
    direction LR
    CLI["Apostadores<br/>web · movil"]
    ADM["Operador · Admin · Auditor<br/>VPN + MFA"]
  end

  subgraph Z2["ZONA PUBLICA · INTERNET · TLS 1.3"]
    direction LR
    CDN["CDN + WAF<br/>cache · anti-bot · anti-DDoS"]
    GW["API GATEWAY + WS/PUSH<br/>valida JWT local (JWKS)<br/>rate limit · sala de espera<br/>push de cuotas a los clientes"]
  end

  subgraph Z3["RED PRIVADA · SERVICIOS · mTLS"]
    direction LR
    IDE["identidad"]
    CORE["NUCLEO · core-apuestas<br/>APUESTAS + BILLETERA<br/>1 transaccion ACID"]
    COMP["competencia<br/>carreras · medianos · resultados"]
  end

  subgraph Z4["DATOS OLTP · consistencia fuerte"]
    direction LR
    PGC[("PostgreSQL core<br/>Multi-AZ · dedicada")]
    PGS[("PostgreSQL compartida<br/>+ Redis")]
  end

  subgraph Z5["MENSAJERIA"]
    direction LR
    KAFKA{{"KAFKA · eventos"}}
    RMQ{{"RABBITMQ · comandos"}}
  end

  subgraph Z6["CONSUMIDORES ASINCRONOS · fuera del camino critico"]
    direction LR
    LIQ["liquidacion<br/>premios por lotes"]
    NOT["notificaciones"]
    ANA["analitica-fraude<br/>+ cuotas en vivo"]
    AUD["auditoria"]
  end

  subgraph Z7["LARGO PLAZO · consistencia eventual"]
    direction LR
    STO[("data lake · OLAP<br/>auditoria WORM 5 anos")]
  end

  CLI --> CDN
  ADM --> CDN
  CDN --> GW
  GW -->|"S4 gRPC apostar"| CORE
  GW -->|"S5 REST carreras"| COMP
  GW -->|"S2 OIDC"| IDE
  CORE -->|"S6 fail-closed"| COMP
  CORE -->|"1 tx ACID"| PGC
  LIQ -->|"tx local"| PGC
  IDE --> PGS
  COMP --> PGS

  CORE -.->|"outbox: ApuestaAceptada"| KAFKA
  COMP -.->|"ResultadoPublicado"| KAFKA
  KAFKA -.->|"CarreraAbierta: cierra_en"| CORE
  KAFKA -.-> NOT
  KAFKA -.-> ANA
  KAFKA -.-> AUD
  KAFKA -.-> LIQ
  CORE ==>|"LiquidarLote"| RMQ
  RMQ ==> LIQ
  NOT ==> RMQ
  NOT --> STO
  ANA --> STO
  AUD --> STO

  classDef cliente fill:#ffffff,stroke:#374151,stroke-width:2px,color:#111827
  classDef publico fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111827
  classDef servicio fill:#bfdbfe,stroke:#1d4ed8,stroke-width:2px,color:#111827
  classDef nucleo fill:#fecaca,stroke:#b91c1c,stroke-width:4px,color:#111827
  classDef datos fill:#d1fae5,stroke:#047857,stroke-width:2px,color:#111827
  classDef broker fill:#e9d5ff,stroke:#7e22ce,stroke-width:3px,color:#111827
  classDef worker fill:#cffafe,stroke:#0e7490,stroke-width:2px,color:#111827
  class CLI,ADM cliente
  class CDN,GW publico
  class IDE,COMP servicio
  class CORE,LIQ nucleo
  class PGC,PGS,STO datos
  class KAFKA,RMQ broker
  class NOT,ANA,AUD worker
```

---

## 2. Vista del camino crítico (solo comunicación **síncrona**)

Todo lo que aquí aparece ocurre **dentro del segundo** que el usuario espera. Obsérvese que desde `core-apuestas` solo sale **una** flecha hacia otro servicio (S6), y es excepcional.

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 25, 'rankSpacing': 65, 'curve': 'basis'}}}%%
flowchart TB
  subgraph P1["CLIENTES"]
    direction LR
    CLI["Apostadores<br/>web · movil"]
    ADM["Operador · Admin · Auditor<br/>VPN + MFA"]
  end
  subgraph P2["ZONA PUBLICA"]
    direction LR
    CDN["CDN + WAF"]
    GW["API GATEWAY<br/>JWT local · rate limit · sala de espera"]
  end
  subgraph P3["RED PRIVADA · SERVICIOS"]
    direction LR
    IDE["identidad"]
    CORE["NUCLEO · core-apuestas<br/>apuestas + billetera"]
    COMP["competencia"]
    ANA["analitica-fraude"]
    AUD["auditoria"]
  end
  subgraph P4["RED PRIVADA · DATOS"]
    direction LR
    PGC[("PostgreSQL core")]
    RED[("Redis")]
    PGS[("PostgreSQL compartida")]
    OLAP[("OLAP")]
    WORM[("Auditoria WORM")]
  end

  CLI -->|"S1 HTTPS / WSS"| CDN
  ADM -->|"S1 HTTPS + MFA"| CDN
  CDN --> GW
  GW -->|"S2 OIDC · S3 JWKS · S10 admin"| IDE
  GW -->|"S4 gRPC CrearApuesta · saldo<br/>800 ms · sin reintento"| CORE
  GW -->|"S5 REST carreras · S10 admin<br/>500 ms · fallback cache"| COMP
  GW -->|"S8 premium · 3 s"| ANA
  GW -->|"S9 auditor · solo lectura"| AUD
  GW --> RED
  CORE -->|"S6 gRPC solo si falla la cache<br/>200 ms · si no responde RECHAZA"| COMP
  COMP -->|"S7 resumen de bolsa"| CORE
  CORE -->|"BEGIN · debito condicional · INSERT · COMMIT"| PGC
  CORE --> RED
  IDE --> PGS
  COMP --> PGS
  ANA --> OLAP
  AUD --> WORM

  classDef cliente fill:#ffffff,stroke:#374151,stroke-width:2px,color:#111827
  classDef publico fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111827
  classDef servicio fill:#bfdbfe,stroke:#1d4ed8,stroke-width:2px,color:#111827
  classDef nucleo fill:#fecaca,stroke:#b91c1c,stroke-width:4px,color:#111827
  classDef datos fill:#d1fae5,stroke:#047857,stroke-width:2px,color:#111827
  class CLI,ADM cliente
  class CDN,GW publico
  class IDE,COMP,ANA,AUD servicio
  class CORE nucleo
  class PGC,PGS,RED,OLAP,WORM datos
```

---

## 3. Vista del flujo **asíncrono** (eventos y comandos)

Nada de lo que aquí aparece está en el camino crítico de una apuesta: todo esto puede retrasarse o caerse sin que nadie deje de apostar.

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 25, 'rankSpacing': 65, 'curve': 'basis'}}}%%
flowchart TB
  subgraph Q1["PRODUCTORES · publican via transactional outbox"]
    direction LR
    CORE["core-apuestas<br/>ApuestaAceptada · ApuestaRechazada<br/>MovimientoBilleteraRegistrado"]
    COMP["competencia<br/>Carrera* · ResultadoPublicado<br/>ResultadoCorregido"]
    IDE["identidad<br/>UsuarioRegistrado<br/>UsuarioEstadoCambiado"]
    LIQ2["liquidacion<br/>LiquidacionCalculada<br/>LiquidacionFinalizada"]
  end

  subgraph Q2["BROKERS GESTIONADOS"]
    direction LR
    KAFKA{{"KAFKA · 8 topics · RF=3<br/>hechos del negocio · replay 7 dias"}}
    RMQ{{"RABBITMQ · exchanges y colas<br/>tareas · retry con TTL · DLQ"}}
  end

  subgraph Q3["CONSUMIDORES"]
    direction LR
    LIQ["worker-liquidacion<br/>cg-liquidacion"]
    STR["stream-cuotas<br/>cg-cuotas"]
    NOT["notificaciones<br/>cg-notificaciones"]
    NOTW["workers de canal<br/>email · push · in-app"]
    ANA["analitica-fraude<br/>cg-analitica"]
    AUD["auditoria<br/>cg-auditoria"]
    PROJ["core-apuestas · proyecciones<br/>cg-core: carrera_apostable<br/>usuarios bloqueados"]
    PROJ2["competencia<br/>cg-competencia: LIQUIDADA"]
    WSC["WS/Push Gateway<br/>cg-ws"]
  end

  subgraph Q4["DESTINOS"]
    direction LR
    LAKE[("Data Lake · OLAP")]
    WORM[("Auditoria WORM<br/>5 anos")]
    EXT["SMTP · FCM/APNs"]
    USR["Clientes conectados"]
  end

  CORE -.-> KAFKA
  COMP -.-> KAFKA
  IDE -.-> KAFKA
  LIQ2 -.-> KAFKA

  KAFKA -.->|"ResultadoPublicado · ResultadoCorregido"| LIQ
  KAFKA -.->|"ApuestaAceptada"| STR
  KAFKA -.->|"Apuesta* · Carrera* · Movimiento*"| NOT
  KAFKA -.->|"todos los eventos"| ANA
  KAFKA -.->|"todos los eventos"| AUD
  KAFKA -.->|"CarreraAbierta con cierra_en<br/>CarreraCancelada · Usuario*"| PROJ
  KAFKA -.->|"LiquidacionFinalizada"| PROJ2
  KAFKA -.->|"CuotasEstimadasActualizadas"| WSC
  STR -.->|"agrega en ventanas de 1 s"| KAFKA

  CORE ==>|"LiquidarLote · lotes de 1.000"| RMQ
  RMQ ==>|"q.liquidacion.lotes · competing consumers"| LIQ
  NOT ==>|"EnviarNotificacion"| RMQ
  RMQ ==>|"q.notif.email / push / inapp + DLQ"| NOTW

  ANA --> LAKE
  AUD --> WORM
  NOTW --> EXT
  WSC --> USR

  classDef servicio fill:#bfdbfe,stroke:#1d4ed8,stroke-width:2px,color:#111827
  classDef nucleo fill:#fecaca,stroke:#b91c1c,stroke-width:4px,color:#111827
  classDef broker fill:#e9d5ff,stroke:#7e22ce,stroke-width:3px,color:#111827
  classDef worker fill:#cffafe,stroke:#0e7490,stroke-width:2px,color:#111827
  classDef datos fill:#d1fae5,stroke:#047857,stroke-width:2px,color:#111827
  classDef externo fill:#e5e7eb,stroke:#6b7280,stroke-width:2px,color:#111827
  class CORE,LIQ,LIQ2 nucleo
  class COMP,IDE servicio
  class KAFKA,RMQ broker
  class STR,NOT,NOTW,ANA,AUD,PROJ,PROJ2,WSC worker
  class LAKE,WORM datos
  class EXT,USR externo
```

---

## 4. Leyenda (bloque aparte, para proyectar al lado)

```mermaid
flowchart LR
  A1["Servicio origen"] -->|"REST / gRPC · espera respuesta"| A2["Servicio destino"]
  B1["Productor"] -.->|"evento Kafka · hecho pasado · releible"| B2["Consumidores independientes"]
  C1["Productor"] ==>|"comando RabbitMQ · reintentos y DLQ"| C2["Workers que compiten"]
  D1["NUCLEO TRANSACCIONAL<br/>aqui vive el dinero"]
  E1["Publico · Internet"]
  F1["Red privada · sin IP publica"]

  classDef nucleo fill:#fecaca,stroke:#b91c1c,stroke-width:4px,color:#111827
  classDef publico fill:#fde68a,stroke:#b45309,stroke-width:2px,color:#111827
  classDef priv fill:#bfdbfe,stroke:#1d4ed8,stroke-width:2px,color:#111827
  class D1 nucleo
  class E1 publico
  class F1 priv
```

---

## 5. Detalle de las aristas (lo que las etiquetas cortas abrevian)

### 5.1 Aristas síncronas

| Código | Origen → Destino | Protocolo | Qué pide | Timeout y fallback |
|---|---|---|---|---|
| S1 | Cliente → CDN/Gateway | HTTPS + WSS | Todas las operaciones del usuario | 2 s; reintento con la **misma** `Idempotency-Key` |
| S2 | Gateway → identidad | OIDC/REST | Login, refresh, registro | 1 s, 1 reintento. Si cae: no hay logins nuevos, **las sesiones vigentes siguen** |
| S3 | Gateway → identidad | HTTP (JWKS) | Claves públicas, **cada 10 min, cacheadas** | Caché + claves anteriores retenidas: no es una llamada por petición |
| S4 | Gateway → core-apuestas | **gRPC** | `CrearApuesta`, saldo, mis apuestas, movimientos | **800 ms, sin reintento en escritura**; circuit breaker → `503 Retry-After` |
| S5 | Gateway → competencia | REST | Carreras, detalle, ficha e historial de medianos | 500 ms, 1 reintento; fallback a caché CDN/Redis |
| S6 | **core-apuestas → competencia** | gRPC | `ObtenerCarreraApostable` — **solo si falla la proyección local** | 200 ms, 1 reintento. Si falla: **se rechaza la apuesta (fail-closed)** |
| S7 | competencia → core-apuestas | gRPC | Resumen de la bolsa para el panel del operador | 1 s; muestra el último valor conocido como "aproximado" |
| S8 | Gateway → analitica-fraude | REST | Estadísticas premium, tendencias | 3 s; fallback al reporte precalculado del día anterior |
| S9 | Gateway → auditoria | REST **solo lectura** | Registro inalterable, reconstrucción de premios | 10 s; respuesta paginada o exportación asíncrona |
| S10 | Gateway → identidad / competencia | REST + MFA | Roles, bloqueos, crear/abrir/cancelar carrera, publicar resultado | 2 s, sin reintento automático; con clave de idempotencia |

### 5.2 Aristas asíncronas — Kafka

**Producción** (siempre vía *transactional outbox*: el evento se escribe en la misma transacción que el cambio de negocio):

| Productor | Eventos | Topic | Clave de partición |
|---|---|---|---|
| core-apuestas | `ApuestaAceptada`, `ApuestaRechazada` | `apuestas.aceptadas` (24p), `apuestas.rechazadas` (6p) | `carreraId` |
| core-apuestas | `MovimientoBilleteraRegistrado` | `billetera.movimientos` (24p) | `usuarioId` |
| competencia | `CarreraProgramada`, `CarreraAbierta`, `CarreraCerrada`, `CarreraIniciada`, `CarreraCancelada` | `competencia.carreras` (6p) | `carreraId` |
| competencia | `ResultadoPublicado`, `ResultadoCorregido` | `competencia.resultados` (6p) | `carreraId` |
| identidad | `UsuarioRegistrado`, `UsuarioEstadoCambiado` | `identidad.usuarios` (3p) | `usuarioId` |
| liquidación | `LiquidacionCalculada`, `LiquidacionFinalizada` | `liquidacion.eventos` (6p) | `carreraId` |
| stream-cuotas | `CuotasEstimadasActualizadas` | `cuotas.estimadas` (6p, compactado) | `carreraId` |

**Consumo** (cada grupo avanza a su propio ritmo sobre el mismo log):

| Consumer group | Servicio | Qué consume y para qué |
|---|---|---|
| `cg-core` | core-apuestas | `CarreraAbierta` (**trae `cierra_en` y participantes** → proyección apostable), `CarreraCerrada`, `CarreraCancelada` (devolución 100 %), `Usuario*` (bloqueados) |
| `cg-liquidacion` | worker-liquidacion | `ResultadoPublicado` y `ResultadoCorregido` → dispara el cálculo pari-mutuel |
| `cg-competencia` | competencia | `LiquidacionFinalizada` → la carrera pasa a **LIQUIDADA** |
| `cg-cuotas` | stream-cuotas | `ApuestaAceptada` → agregación en ventanas de 1 s |
| `cg-ws` | WS/Push Gateway | `CuotasEstimadasActualizadas`, `CarreraCerrada`, `CarreraIniciada` → push a 100.000 clientes |
| `cg-notificaciones` | notificaciones | `ApuestaAceptada`, `Carrera*`, `ResultadoPublicado`, `MovimientoBilleteraRegistrado` (filtra premio y devolución) |
| `cg-analitica` | analitica-fraude | **Todos** los eventos → data lake, OLAP y reglas de fraude |
| `cg-auditoria` | auditoria | **Todos** los eventos → almacén WORM con cadena de hashes |

### 5.3 Aristas asíncronas — RabbitMQ

| Comando | Exchange (tipo) | Routing key | Cola → consumidor |
|---|---|---|---|
| `LiquidarLote` | `liquidacion` (direct) | `liquidacion.lote` | `q.liquidacion.lotes` → **N workers que compiten** (prefetch 10) → `q.liquidacion.lotes.dlq` |
| `EnviarNotificacion` | `notificaciones` (topic) | `notif.email.*`, `notif.push.*`, `notif.inapp.*` | `q.notif.email` / `q.notif.push` / `q.notif.inapp` → workers de canal → `q.notif.retry` (TTL 5 s/30 s/5 min) → `q.notif.dlq` |
| `RecalcularEstadisticas` | `analitica` (direct) | `analitica.recalculo` | `q.analitica.recalculo` → workers ETL |

---

## 6. Cómo "leer" el diagrama en la sustentación (3 ideas que debe comunicar)

1. **El camino crítico es cortísimo y no sale de una base de datos.** De `Cliente` a `COMMIT` hay tres saltos (CDN → Gateway → core-apuestas → PostgreSQL) y **ninguna llamada síncrona entre servicios**. Por eso se cumple el SLA de <1 s con 10.000 apuestas/s. La única flecha síncrona que sale del núcleo (S6 → `competencia`) es excepcional, solo ocurre si falla la proyección local, y si no responde **se rechaza la apuesta** (*fail-closed*).
2. **Todo lo discontinuo o grueso puede caerse sin que nadie deje de apostar.** Notificaciones, analítica, fraude, auditoría, cuotas en vivo, Kafka y RabbitMQ están **fuera** del camino crítico; los eventos esperan en el *outbox* o en el *log* de Kafka. Lo único que no se degrada es el dinero: eso responde de un vistazo los Casos A y B del enunciado.
3. **La caja roja es la respuesta a la pregunta difícil.** Apuestas y Billetera están en la misma caja y en la misma base de datos **a propósito**: ahí el doble gasto y el saldo negativo son imposibles por construcción (débito condicional + restricciones `UNIQUE`), sin sagas ni compensaciones.

---

## 7. Verificación contra el enunciado

| Requisito del diagrama general | Cómo lo cumple |
|---|---|
| Mostrar el flujo Cliente → Gateway → Servicios → BD → Broker → Consumidores | Las 7 zonas de la vista integrada, recorridas en ese orden; la vista 2 aísla el tramo síncrono y la vista 3 el tramo broker → consumidores |
| **Diferenciar visualmente** síncrono vs. asíncrono | Tres trazos distintos (continuo / discontinuo / grueso) **más** dos vistas separadas, una por tipo de comunicación |
| Indicar componentes públicos y privados | La zona amarilla es la única pública; el resto está rotulado como "RED PRIVADA" en el título de cada zona |
| Mostrar los servicios decididos | 6 servicios + API Gateway + WS/Push, con los módulos internos escritos dentro de cada caja (**medianos** dentro de `competencia`, **liquidación** como worker del núcleo) |
| Mostrar las bases de datos y su reparto | `PostgreSQL core` dedicada, `PostgreSQL compartida` + Redis, data lake, OLAP y auditoría WORM |
| Mostrar broker(s) y consumidores | Kafka y RabbitMQ en su propia zona; cada consumer group y cada cola aparecen en la vista 3 y se detallan en §5.2 y §5.3 |

---

## 8. Notas de uso

- **Renderizado:** los cuatro bloques están validados con Mermaid 10.9. Se ven directamente en GitHub, VS Code, Obsidian y Typora, y en [mermaid.live](https://mermaid.live), desde donde se exportan a PNG o SVG para pegarlos en la presentación.
- **Proporciones** (ancho × alto del SVG): vista integrada 1959×1288 (1,52:1), vista síncrona 1647×994 (1,66:1), vista asíncrona 2661×1048 (2,54:1). Las dos primeras caben cómodas en una diapositiva 16:9; la tercera conviene proyectarla a lo ancho.
- **Si el renderizador no admite la directiva `%%{init}`** (versiones antiguas), basta con borrar la primera línea del bloque: el diagrama sigue siendo válido, solo cambia el espaciado.

- **Coherencia con los demás entregables gráficos:** los códigos de arista (`S1`…`S10`), los nombres de evento y los `cg-*` son los mismos que usa [`diagrama-secuencia-apuesta.md`](diagrama-secuencia-apuesta.md) (entregable 12.2), de modo que un evaluador puede seguir la misma apuesta de un diagrama al otro.

> **Siguiente entregable gráfico pendiente:** diseño detallado de mensajería (entregable 12.3) con exchanges, colas, routing keys, topics, particiones y consumer groups — Anexos A.3 y A.4 de `decisiones-arquitectura.md`.

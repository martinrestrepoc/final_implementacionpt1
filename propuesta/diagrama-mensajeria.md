# Diseño de la mensajería — La Gran Liga de Apuestas de Medianos EIA

> Sale de `decisiones-arquitectura.md` (decisiones 4 y 5). Cubre el entregable 12.3 del enunciado: **el diseño de la mensajería**, con los elementos que pide explícitamente.
>
> No hay nada que configurar ni ejecutar: esto es el diseño.

## Qué pide el enunciado y dónde está en el dibujo

| Lo que pide | Dónde se ve |
|---|---|
| **Producer** (Kafka y RabbitMQ) | Las cajas azules: Apuestas publica en los dos, y Notificaciones publica en RabbitMQ |
| **Topic** | `apuestas.aceptadas`, el recuadro que agrupa las Partitions |
| **Partitions** | Las 24 del topic. Dibujamos las tres primeras y resumimos el resto |
| **Consumer Groups** | Los cuatro recuadros de la derecha: estadisticas, auditoria, cuotas y notificaciones |
| **Consumers** | Las cajas celestes dentro de cada grupo. Un grupo puede tener varios |
| **Exchange** | Los dos hexágonos: `liquidacion`, de tipo direct, y `notificaciones`, de tipo topic |
| **Routing** | Las etiquetas sobre las flechas que salen del Exchange: la routing key decide a qué Queue va el mensaje |
| **Queue** | Las cajas de borde café: una por tarea y una por canal, más la de los mensajes con problemas |
| **Consumer** (RabbitMQ) | Las cajas celestes al final de cada Queue |

---

## El diagrama

```mermaid
%%{init: {'htmlLabels': false, 'flowchart': {'htmlLabels': false, 'wrappingWidth': 280, 'nodeSpacing': 28, 'rankSpacing': 60, 'curve': 'basis'}}}%%
flowchart TB
  subgraph K["KAFKA · los hechos del negocio"]
    direction LR
    KPROD["Producer<br/>Apuestas"]
    subgraph KT["Topic · apuestas.aceptadas"]
      direction TB
      KP0["Partition 0"]
      KP1["Partition 1"]
      KP2["Partition 2"]
      KPN["Partitions 3 a 23"]
    end
    subgraph KG1["Consumer Group · estadisticas"]
      direction TB
      KC1["Consumer"]
      KC2["Consumer"]
    end
    subgraph KG2["Consumer Group · auditoria"]
      direction TB
      KC3["Consumer"]
    end
    subgraph KG3["Consumer Group · cuotas"]
      direction TB
      KC4["Consumer"]
    end
    subgraph KG4["Consumer Group · notificaciones"]
      direction TB
      KC5["Consumer"]
    end
    KPROD -->|"la clave carreraId<br/>decide la Partition"| KT
    KT --> KG1
    KT --> KG2
    KT --> KG3
    KT --> KG4
  end

  subgraph R["RABBITMQ · las tareas por hacer"]
    direction LR
    RP1["Producer<br/>Apuestas"]
    RE1{{"Exchange · liquidacion<br/>tipo direct"}}
    RQ1[["Queue<br/>q.liquidacion.lotes"]]
    RC1["Consumer"]
    RC2["Consumer"]
    RQD[["Queue<br/>q.liquidacion.lotes.dlq"]]
    RP2["Producer<br/>Notificaciones"]
    RE2{{"Exchange · notificaciones<br/>tipo topic"}}
    RQ2[["Queue<br/>q.notif.email"]]
    RQ3[["Queue<br/>q.notif.push"]]
    RQ4[["Queue<br/>q.notif.inapp"]]
    RC3["Consumer"]
    RC4["Consumer"]
    RC5["Consumer"]
    RP1 --> RE1
    RE1 -->|"Routing key<br/>liquidacion.lote"| RQ1
    RQ1 --> RC1
    RQ1 --> RC2
    RQ1 -->|"tras varios intentos"| RQD
    RP2 --> RE2
    RE2 -->|"Routing key<br/>notif.email.*"| RQ2
    RE2 -->|"Routing key<br/>notif.push.*"| RQ3
    RE2 -->|"Routing key<br/>notif.inapp.*"| RQ4
    RQ2 --> RC3
    RQ3 --> RC4
    RQ4 --> RC5
  end

  K ~~~ R

  classDef productor fill:#bfdbfe,stroke:#1d4ed8,stroke-width:2px,color:#111827
  classDef particion fill:#ede9fe,stroke:#7e22ce,stroke-width:1.5px,color:#111827
  classDef exchange fill:#e9d5ff,stroke:#7e22ce,stroke-width:3px,color:#111827
  classDef cola fill:#f1e7da,stroke:#8b4a20,stroke-width:2px,color:#111827
  classDef consumidor fill:#cffafe,stroke:#0e7490,stroke-width:2px,color:#111827
  class KPROD,RP1,RP2 productor
  class KP0,KP1,KP2,KPN particion
  class RE1,RE2 exchange
  class RQ1,RQ2,RQ3,RQ4,RQD cola
  class KC1,KC2,KC3,KC4,KC5,RC1,RC2,RC3,RC4,RC5 consumidor
```

---

## Cómo leerlo

**Kafka, arriba.** Apuestas publica el hecho `ApuestaAceptada` en el **Topic** `apuestas.aceptadas`. La clave `carreraId` decide en qué **Partition** cae cada mensaje, y eso garantiza que todas las apuestas de una misma carrera lleguen **en orden** al mismo consumidor. Cuatro **Consumer Groups** leen ese mismo topic, cada uno por su cuenta y a su ritmo: lo que lee auditoría no le quita nada a estadísticas. Dentro de un grupo, los **Consumers** se reparten las particiones, así que agregar consumidores a un grupo aumenta su velocidad hasta el número de particiones.

**RabbitMQ, abajo.** Aquí no se publica un hecho, se encarga una tarea. El **Producer** manda el mensaje a un **Exchange**, y la **routing key** decide a qué **Queue** va: `liquidacion.lote` lleva cada lote de pagos a `q.liquidacion.lotes`, donde varios **Consumers** se los reparten —el que esté libre toma el siguiente—; y `notif.email.*`, `notif.push.*` y `notif.inapp.*` llevan cada aviso a la cola de su canal, de modo que un canal caído no frena a los otros. Si una tarea falla demasiadas veces, pasa a la **Queue** de mensajes con problemas en vez de bloquear a las que vienen detrás.

**La diferencia en una línea:** en Kafka el mensaje se queda y lo leen todos los que quieran; en RabbitMQ el mensaje se entrega a uno y desaparece cuando queda hecho.

---

## Notas de uso

- El bloque es Mermaid y se ve directo en GitHub, VS Code y [mermaid.live](https://mermaid.live).
- Archivo fuente: [diagramas/mensajeria.mmd](diagramas/mensajeria.mmd).
- En la presentación está en la diapositiva 9: el botón **Ver el diseño completo** lo abre en grande, con zoom y descarga.
- Los nombres de topics, exchanges, colas y claves son los mismos de `decisiones-arquitectura.md` y de `diagrama-general.md`.

# La Gran Liga de Apuestas de Medianos EIA

Trabajo de Implementación e integración de software. **Salchipapa Maker Racing S.A.S.** nos contrata como arquitectos para diseñar la plataforma de apuestas de carreras de medianos.

Es una **propuesta de diseño**: no se implementa nada, se decide y se justifica.

## Qué hay en cada carpeta

| Carpeta | Qué contiene |
|---|---|
| **`enunciado/`** | El enunciado original en PDF y su transcripción completa en `contexto-proyecto.md`, que es la que usamos para trabajar |
| **`propuesta/`** | El entregable: las decisiones y los diagramas |
| **`presentacion/`** | La presentación de 20 diapositivas. Se abre con doble clic en `index.html`, sin instalar nada |

## El entregable, archivo por archivo

| Archivo | Qué responde |
|---|---|
| [`propuesta/decisiones-arquitectura.md`](propuesta/decisiones-arquitectura.md) | Las nueve decisiones obligatorias, seguridad, costos, los tres ADR y la pregunta final. Es el documento principal: todo lo demás sale de aquí |
| [`propuesta/diagrama-general.md`](propuesta/diagrama-general.md) | Entregable 12.1: el diagrama general, con el detalle de cada flecha |
| [`propuesta/diagrama-secuencia-apuesta.md`](propuesta/diagrama-secuencia-apuesta.md) | Entregable 12.2: el camino de una apuesta y el caso de los cuatro clics |
| [`propuesta/diagrama-mensajeria.md`](propuesta/diagrama-mensajeria.md) | Entregable 12.3: el diseño de la mensajería, con Producer, Topic, Partitions, Consumer Groups, Consumers, Exchange, Routing y Queue |
| [`propuesta/diagramas/`](propuesta/diagramas) | Los archivos Mermaid de los tres dibujos, por si hay que editarlos o exportarlos |
| [`presentacion/guion.md`](presentacion/guion.md) | Lo que va en cada diapositiva, con las notas del expositor |

## La propuesta en seis líneas

1. **Un servicio central** guarda la apuesta y los EIA Coins juntos: o se guardan los dos, o no se guarda ninguno.
2. **Cinco servicios alrededor** —Usuarios, Carreras, Notificaciones, Estadísticas y Auditoría— para que su caída no impida apostar.
3. **Una sola puerta de entrada** por donde pasa todo.
4. **Síncrono solo lo que el usuario espera en pantalla.** Lo demás, por eventos.
5. **Kafka** para los hechos que varios necesitan y queremos poder releer; **RabbitMQ** para las tareas que se reparten y se reintentan.
6. **Seis servicios, no veinte.** La complejidad justa.

## Cómo ver los diagramas

Los cuatro `.md` de `propuesta/` traen los diagramas escritos en Mermaid y se ven directo en GitHub o en VS Code. Para exportarlos a imagen, se pegan en [mermaid.live](https://mermaid.live). La presentación ya los trae dibujados: el botón **Ampliar diagrama** los abre en grande.

## La presentación

Se abre con doble clic en [`presentacion/index.html`](presentacion/index.html), sin instalar ni conectar nada. Veinte diapositivas, con el mismo lenguaje y los mismos nombres de `propuesta/`.

- **Flechas** o **espacio** para avanzar · **I** para el índice · **F** para pantalla completa.
- **N** abre las notas del expositor. Conviene ocultarlas antes de proyectar.
- En las diapositivas 4, 5, 9 y 10 hay un botón que abre el diagrama completo, con zoom y descarga.

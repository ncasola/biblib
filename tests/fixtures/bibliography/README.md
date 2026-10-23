# Fixtures de adaptadores bibliográficos

Las pruebas leen estos archivos sin acceso a Internet. `open-library/*.json` y `bne/constructed.xml` son construidos; los dos XML restantes de BNE son recortes de respuestas públicas puntuales del 23-10-2026, con evidencia en `bne/probe.json` y detalle en `docs/validacion/2026-10-23/O08/bib-02.md`.

Los metadatos BNE se atribuyen a la Biblioteca Nacional de España (CC0, según su aviso legal); no se incluyen ni se conceden derechos sobre imágenes. El recorte conserva el caso real en que la consulta ISBN devuelve registros relacionados: el mapper debe usar exclusivamente 020 para confirmar coincidencia, sin tomar el ISBN de 776. Se excluyeron datos de ejemplares, disponibilidad y fechas biográficas; los nombres conservados son autorías bibliográficas públicas.

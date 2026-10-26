# Comparación antes (0009) / después (0011) · 10 000 fichas

## Acciones (p95, ms)

| Escenario | c | antes acción p95 | después acción p95 | antes SQL p95 | después SQL p95 |
| --- | --- | --- | --- | --- | --- |
| dashboard | 1 | 99.7 | 88.8 | 12.06 | 16.21 |
| dashboard | 5 | 120.8 | 117.8 | — | — |
| dashboard | 10 | 199 | 188.5 | — | — |
| listado-inicial | 1 | 77.8 | 81.5 | 1.12 | 8.08 |
| listado-inicial | 5 | 108.5 | 110.5 | — | — |
| listado-inicial | 10 | 167.2 | 181.5 | — | — |
| listado-100-filas | 1 | 79.7 | 93.3 | 2.15 | 13.78 |
| listado-100-filas | 5 | 110.4 | 148.2 | — | — |
| listado-100-filas | 10 | 186.3 | 244 | — | — |
| listado-ultima-pagina | 1 | 119 | 97.3 | 46.49 | 25.51 |
| listado-ultima-pagina | 5 | 139.7 | 131.6 | — | — |
| listado-ultima-pagina | 10 | 291.3 | 217.4 | — | — |
| filtrado-estado-estanteria | 1 | 69.7 | 74.6 | 2.67 | 7.07 |
| filtrado-estado-estanteria | 5 | 129.5 | 131.8 | — | — |
| filtrado-estado-estanteria | 10 | 218.2 | 239.1 | — | — |
| ordenado-autor | 1 | 119.7 | 119.8 | 17.49 | 16.28 |
| ordenado-autor | 5 | 169.8 | 167.2 | — | — |
| ordenado-autor | 10 | 307.4 | 240.2 | — | — |
| ordenado-fecha | 1 | 111.4 | 96.3 | 31.12 | 25.45 |
| ordenado-fecha | 5 | 143.4 | 132.3 | — | — |
| ordenado-fecha | 10 | 191 | 203.1 | — | — |
| busqueda-local-texto | 1 | 172.9 | 105.3 | 103.69 | 30.37 |
| busqueda-local-texto | 5 | 269.2 | 124 | — | — |
| busqueda-local-texto | 10 | 406.1 | 202.8 | — | — |
| busqueda-local-isbn | 1 | 210 | 97 | 141.6 | 29.38 |
| busqueda-local-isbn | 5 | 298.1 | 120 | — | — |
| busqueda-local-isbn | 10 | 462.7 | 209.7 | — | — |
| detalle | 1 | 63.2 | 62.6 | 0.1 | 0.13 |
| detalle | 5 | 98.2 | 89.7 | — | — |
| detalle | 10 | 139.2 | 155.6 | — | — |
| estanterias | 1 | 70.5 | 106.1 | 6.82 | 5.57 |
| estanterias | 5 | 107.9 | 288.2 | — | — |
| estanterias | 10 | 243.6 | 256.9 | — | — |
| estanteria-3d-pagina-48 | 1 | 99.8 | 101.8 | 3.97 | 11.55 |
| estanteria-3d-pagina-48 | 5 | 93.8 | 131.9 | — | — |
| estanteria-3d-pagina-48 | 10 | 177.3 | 215.3 | — | — |
| ajustes-recuentos | 1 | 97.4 | 100.4 | 0.86 | 6.05 |
| ajustes-recuentos | 5 | 123.2 | 100.5 | — | — |
| ajustes-recuentos | 10 | 199.8 | 197.6 | — | — |
| exportacion-servidor | 1 | 492.9 | 757.7 | 101.76 | 165.76 |
| exportacion-servidor | 5 | 1921 | 4445.6 | — | — |
| exportacion-servidor | 10 | 4569.6 | 7480.1 | — | — |
| preview-importacion-conservar | 1 | 242.9 | 334.7 | 34.22 | 45.83 |
| preview-importacion-conservar | 5 | 1167.9 | 1308.4 | — | — |
| preview-importacion-conservar | 10 | 1758.5 | 2382.5 | — | — |
| preview-importacion-nuevos | 1 | 297.4 | 362.8 | 49.06 | 60.1 |
| preview-importacion-nuevos | 5 | 1447 | 1535.7 | — | — |
| preview-importacion-nuevos | 10 | 2216.6 | 2603.9 | — | — |
| preview-importacion-reemplazo | 1 | 307.1 | 354.8 | 47.56 | 57.68 |
| preview-importacion-reemplazo | 5 | 1318.2 | 1563.1 | — | — |
| preview-importacion-reemplazo | 10 | 2070.7 | 2496.3 | — | — |
| consulta-isbn-alta | 1 | 85.9 | 66.7 | 8.36 | 0.13 |
| consulta-isbn-alta | 5 | 175.8 | 95.2 | — | — |
| consulta-isbn-alta | 10 | 312 | 161.1 | — | — |

Exportación: antes formato 1, 5 partes, descarga p95 639.3 ms; después formato 1, 5 partes, descarga p95 979.7 ms
Aislamiento: antes {"duracionMs":12000,"sesionesDeCarga":10,"peticiones":{"escala":777,"a":75,"b":80},"comprobaciones":932,"violaciones":0,; después {"duracionMs":12000,"sesionesDeCarga":10,"peticiones":{"escala":794,"a":85,"b":85},"comprobaciones":964,"violaciones":0,

## Consultas EXPLAIN ANALYZE (ms)

| Consulta | antes p50/p95 (ms) | después p50/p95 (ms) |
| --- | --- | --- |
| `resumen.totales` | 4.125 / 4.565 | 7.143 / 7.361 |
| `resumen.recientes` | 0.04 / 0.052 | 0.112 / 0.141 |
| `resumen.leyendo` | 3.236 / 3.429 | 7.635 / 8.092 |
| `listado.recuento` | 0.875 / 0.976 | 5.704 / 6.01 |
| `listado.pagina-1` | 0.046 / 0.069 | 0.077 / 0.117 |
| `listado.ultima-pagina` | 33.462 / 42.382 | 17.572 / 18.925 |
| `filtrado.recuento` | 0.756 / 1.072 | 3.565 / 5.577 |
| `filtrado.pagina` | 1.305 / 1.582 | 3.203 / 4.373 |
| `orden.autor` | 13.738 / 16.161 | 9.459 / 11.52 |
| `orden.fecha` | 22.696 / 25.34 | 18.479 / 20.638 |
| `busqueda.recuento` | 45.517 / 48.665 | 11.913 / 12.428 |
| `busqueda.pagina` | 1.414 / 1.525 | 0.786 / 0.958 |
| `busqueda.isbn` | 77.353 / 86.749 | 12.974 / 19.587 |
| `busqueda.isbn-exacto` | 46.122 / 52.481 | 13.038 / 14.207 |
| `detalle` | 0.044 / 0.079 | 0.098 / 0.139 |
| `estanterias` | 6.149 / 6.582 | 4.905 / 5.113 |
| `3d.pagina` | 0.115 / 0.179 | 1.394 / 1.792 |
| `exportacion.todo` | 30.402 / 31.898 | 36.264 / 39.635 |
| `isbn.escaneo` | 1.898 / 2.172 | — |
| `importacion.instantanea` | 4.156 / 5.029 | 9.066 / 9.949 |
| `listado.filas` | — | 0.823 / 1.223 |
| `exportacion.orden` | — | 17.834 / 22.696 |
| `isbn.igualdad` | — | 0.074 / 0.097 |

## Código final (export en una consulta, vista previa v2)

| Escenario | c | antes acción p95 | final acción p95 | antes SQL p95 | final SQL p95 |
| --- | --- | --- | --- | --- | --- |
| exportacion-servidor | 1 | 492.9 | 737.2 | 101.76 | 156.08 |
| exportacion-servidor | 5 | 1921 | 4670.5 | — | — |
| exportacion-servidor | 10 | 4569.6 | 6791.5 | — | — |
| preview-importacion-conservar | 1 | 242.9 | 299.7 | 34.22 | 42.44 |
| preview-importacion-conservar | 5 | 1167.9 | 1399.8 | — | — |
| preview-importacion-conservar | 10 | 1758.5 | 2250.5 | — | — |
| preview-importacion-nuevos | 1 | 297.4 | 410.5 | 49.06 | 69.09 |
| preview-importacion-nuevos | 5 | 1447 | 1697.6 | — | — |
| preview-importacion-nuevos | 10 | 2216.6 | 2747 | — | — |
| preview-importacion-reemplazo | 1 | 307.1 | 367.5 | 47.56 | 64.51 |
| preview-importacion-reemplazo | 5 | 1318.2 | 1667.5 | — | — |
| preview-importacion-reemplazo | 10 | 2070.7 | 2740.2 | — | — |

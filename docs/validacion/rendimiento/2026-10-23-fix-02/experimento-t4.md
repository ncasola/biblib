| Variante | Escenario | Sesiones | Acción p50 / p95 (ms) | GoTrue servidor p50 / p95 | Llamadas Auth por acción | SQL p50 / p95 (1 sesión) | Pool máx. | Peticiones/s | Errores |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base | dashboard | 1 | 151.3 / 166.9 | 49.57 / 58.2 | 2.1 | 19.71 / 23.81 | 1 | 6.4 | 0 |
| base | dashboard | 5 | 267.1 / 406.9 | 57.35 / 71.13 | 2.06 | — | 1 | 17.2 | 0 |
| base | dashboard | 10 | 566 / 637.7 | 61.04 / 101.58 | 2.04 | — | 1 | 17.2 | 0 |
| base | listado-100-filas | 1 | 138.9 / 157.8 | 50.31 / 61.38 | 2.1 | 13.3 / 18.09 | 1 | 6.8 | 0 |
| base | listado-100-filas | 5 | 238.9 / 293.8 | 71.35 / 117.3 | 2.06 | — | 1 | 20 | 0 |
| base | listado-100-filas | 10 | 482 / 577.9 | 145.99 / 185.03 | 2.03 | — | 1 | 19.9 | 0 |
| base | busqueda-local-texto | 1 | 242 / 317.8 | 50.77 / 92.34 | 2.05 | 109.55 / 129.33 | 1 | 3.9 | 0 |
| base | busqueda-local-texto | 5 | 658.7 / 689.2 | 49.23 / 62.2 | 2.04 | — | 1 | 7.5 | 0 |
| base | busqueda-local-texto | 10 | 1333.4 / 1477.7 | 50.38 / 90 | 2.03 | — | 1 | 7.4 | 0 |
| pool-2 | dashboard | 1 | 147.4 / 169.3 | 48.28 / 61.94 | 2.08 | 19.84 / 22.96 | 1 | 6.5 | 0 |
| pool-2 | dashboard | 5 | 208.9 / 236.3 | 65.41 / 78.37 | 2.06 | — | 2 | 23.4 | 0 |
| pool-2 | dashboard | 10 | 374.8 / 425.3 | 82.41 / 120.04 | 2.04 | — | 2 | 25.9 | 0 |
| pool-2 | listado-100-filas | 1 | 136.2 / 154.5 | 48.48 / 60.8 | 2.1 | 13.78 / 16.49 | 2 | 7 | 0 |
| pool-2 | listado-100-filas | 5 | 238.9 / 306.6 | 79.62 / 103.5 | 2.06 | — | 2 | 20.1 | 0 |
| pool-2 | listado-100-filas | 10 | 437.1 / 625.8 | 133.59 / 181.13 | 2.04 | — | 2 | 21.7 | 0 |
| pool-2 | busqueda-local-texto | 1 | 258.5 / 306.2 | 56.08 / 65.52 | 2.07 | 122.18 / 151.96 | 2 | 3.7 | 0 |
| pool-2 | busqueda-local-texto | 5 | 400.4 / 477.6 | 100.67 / 127.86 | 2.04 | — | 2 | 12.1 | 0 |
| pool-2 | busqueda-local-texto | 10 | 864.9 / 1184.5 | 67.57 / 121.63 | 2.03 | — | 2 | 10.9 | 0 |
| pool-4 | dashboard | 1 | 149.5 / 171 | 48.78 / 57.99 | 2.1 | 20.11 / 23.74 | 1 | 6.5 | 0 |
| pool-4 | dashboard | 5 | 206.3 / 258.1 | 66.73 / 93.48 | 2.06 | — | 4 | 23 | 0 |
| pool-4 | dashboard | 10 | 398.1 / 542 | 131.05 / 178.39 | 2.04 | — | 4 | 24.2 | 0 |
| pool-4 | listado-100-filas | 1 | 144.3 / 163.2 | 52.43 / 59.86 | 2.1 | 14.48 / 19.94 | 4 | 6.6 | 0 |
| pool-4 | listado-100-filas | 5 | 243.9 / 301 | 80.16 / 113.2 | 2.06 | — | 4 | 19.7 | 0 |
| pool-4 | listado-100-filas | 10 | 407.5 / 579.7 | 146.92 / 203.87 | 2.04 | — | 4 | 23.4 | 0 |
| pool-4 | busqueda-local-texto | 1 | 251.3 / 291.8 | 54.58 / 63.87 | 2.07 | 117.54 / 138 | 4 | 3.9 | 0 |
| pool-4 | busqueda-local-texto | 5 | 447.5 / 642.9 | 111.36 / 202.43 | 2.04 | — | 4 | 10.8 | 0 |
| pool-4 | busqueda-local-texto | 10 | 618.8 / 1178.8 | 113.1 / 271.74 | 2.02 | — | 4 | 14.7 | 0 |
| sin-getuser-accion | dashboard | 1 | 109.3 / 133.9 | 54.97 / 66.44 | 1.05 | 22.18 / 27.59 | 1 | 8.8 | 0 |
| sin-getuser-accion | dashboard | 5 | 261.4 / 328.6 | 56.68 / 74.16 | 1.03 | — | 1 | 18.3 | 0 |
| sin-getuser-accion | dashboard | 10 | 511.4 / 603.6 | 55.38 / 98.87 | 1.02 | — | 1 | 19.2 | 0 |
| sin-getuser-accion | listado-100-filas | 1 | 87.7 / 111.6 | 51.18 / 59.52 | 1.05 | 13.51 / 18.58 | 1 | 10.4 | 0 |
| sin-getuser-accion | listado-100-filas | 5 | 176.3 / 201 | 54.91 / 70.14 | 1.03 | — | 1 | 27.4 | 0 |
| sin-getuser-accion | listado-100-filas | 10 | 353.4 / 374.4 | 55.47 / 111.36 | 1.02 | — | 1 | 27.7 | 0 |
| sin-getuser-accion | busqueda-local-texto | 1 | 179.2 / 197.5 | 48.81 / 56.62 | 1.05 | 109.53 / 122.88 | 1 | 5.5 | 0 |
| sin-getuser-accion | busqueda-local-texto | 5 | 656.4 / 818.5 | 52.43 / 74.26 | 1.03 | — | 1 | 7.3 | 0 |
| sin-getuser-accion | busqueda-local-texto | 10 | 1270.5 / 1338.7 | 49.02 / 105.61 | 1.02 | — | 1 | 7.8 | 0 |
| idas-minimas | dashboard | 1 | 157.9 / 180.4 | 53.2 / 63.9 | 2.08 | 22.72 / 28.01 | 1 | 6.2 | 0 |
| idas-minimas | dashboard | 5 | 274.6 / 398.5 | 69.87 / 97.99 | 2.06 | — | 1 | 17.2 | 0 |
| idas-minimas | dashboard | 10 | 531 / 626.6 | 68.76 / 119.48 | 2.04 | — | 1 | 18.2 | 0 |
| idas-minimas | listado-100-filas | 1 | 145 / 173.7 | 52.74 / 64.7 | 2.1 | 14.31 / 18.58 | 1 | 6.7 | 0 |
| idas-minimas | listado-100-filas | 5 | 240.5 / 336.8 | 76.35 / 102.48 | 2.06 | — | 1 | 20 | 0 |
| idas-minimas | listado-100-filas | 10 | 444.8 / 569.5 | 75.81 / 118.54 | 2.04 | — | 1 | 21.6 | 0 |
| idas-minimas | busqueda-local-texto | 1 | 250.6 / 346 | 52.84 / 64.31 | 2.07 | 122.25 / 178.47 | 1 | 3.8 | 0 |
| idas-minimas | busqueda-local-texto | 5 | 691.4 / 759.3 | 52.26 / 74.99 | 2.04 | — | 1 | 7.2 | 0 |
| idas-minimas | busqueda-local-texto | 10 | 1410.4 / 1708.1 | 53.8 / 112.16 | 2.03 | — | 1 | 6.9 | 0 |
| sin-getuser | dashboard | 1 | 44.3 / 53.3 | — | 0 | 19.85 / 24.46 | 1 | 20.6 | 0 |
| sin-getuser | dashboard | 5 | 209.4 / 231.5 | — | 0 | — | 1 | 23.6 | 0 |
| sin-getuser | dashboard | 10 | 420.5 / 442.2 | — | 0 | — | 1 | 23.7 | 0 |
| sin-getuser | listado-100-filas | 1 | 31.9 / 39.8 | — | 0 | 12.95 / 17.31 | 1 | 26.7 | 0 |
| sin-getuser | listado-100-filas | 5 | 151.1 / 167.7 | — | 0 | — | 1 | 32.5 | 0 |
| sin-getuser | listado-100-filas | 10 | 322.7 / 373.6 | — | 0 | — | 1 | 30.6 | 0 |
| sin-getuser | busqueda-local-texto | 1 | 126 / 140.1 | — | 0 | 109.29 / 121.1 | 1 | 7.7 | 0 |
| sin-getuser | busqueda-local-texto | 5 | 642 / 697.4 | — | 0 | — | 1 | 7.7 | 0 |
| sin-getuser | busqueda-local-texto | 10 | 1351.7 / 1686.9 | — | 0 | — | 1 | 7.1 | 0 |

| Variante | Sonda | 1 en paralelo p50 / p95 (ms) | 5 en paralelo p50 / p95 (ms) | 10 en paralelo p50 / p95 (ms) |
| --- | --- | --- | --- | --- |
| base | GET /login (Next sin Auth ni DB) | 7.4 / 12.2 | 27.8 / 35.5 | 47.3 / 59.9 |
| pool-2 | GET /login (Next sin Auth ni DB) | 9 / 17.1 | 30.9 / 36.5 | 52.3 / 78.7 |
| pool-4 | GET /login (Next sin Auth ni DB) | 8.1 / 13.4 | 25.9 / 36.7 | 46.5 / 64.9 |
| sin-getuser-accion | GET /login (Next sin Auth ni DB) | 10.3 / 14.8 | 38.5 / 57.1 | 75.9 / 127.5 |
| idas-minimas | GET /login (Next sin Auth ni DB) | 7 / 12.8 | 27.3 / 36.8 | 53 / 81.4 |
| sin-getuser | GET /login (Next sin Auth ni DB) | 7.1 / 13.2 | 31.6 / 44.1 | 46.4 / 61.1 |
| — | GET /auth/v1/user directo a Kong (inicio) | 50.9 / 61.5 | 74.3 / 95.8 | 121.4 / 150.3 |
| — | GET /auth/v1/user directo a Kong (final) | 57.1 / 67.8 | 89.6 / 117.1 | 176.2 / 250 |

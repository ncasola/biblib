| Variante | Escenario | Sesiones | Acción p50 / p95 (ms) | GoTrue servidor p50 / p95 | Llamadas Auth por acción | SQL p50 / p95 (1 sesión) | Pool máx. | Peticiones/s | Errores |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base | dashboard | 1 | 105.1 / 140.9 | 53.3 / 76.15 | 1.05 | 24.87 / 35.48 | 1 | 8.7 | 0 |
| base | dashboard | 5 | 171.2 / 217.7 | 87.41 / 122.83 | 1.03 | — | 4 | 27.8 | 0 |
| base | dashboard | 10 | 279.1 / 351.6 | 138.39 / 177.22 | 1.02 | — | 4 | 35.2 | 0 |
| base | listado-100-filas | 1 | 88 / 101.7 | 50.79 / 65.51 | 1.05 | 15.5 / 18.65 | 4 | 10.6 | 0 |
| base | listado-100-filas | 5 | 137.1 / 177.7 | 71.92 / 105.52 | 1.03 | — | 4 | 35 | 0 |
| base | listado-100-filas | 10 | 244 / 324.2 | 115.67 / 160.23 | 1.02 | — | 4 | 39.2 | 0 |
| base | busqueda-local-texto | 1 | 194.6 / 242.5 | 51.6 / 66.4 | 1.05 | 123.94 / 156.7 | 4 | 4.9 | 0 |
| base | busqueda-local-texto | 5 | 259.5 / 319.4 | 66.03 / 86 | 1.03 | — | 4 | 18.4 | 0 |
| base | busqueda-local-texto | 10 | 546 / 671.5 | 95.28 / 145.25 | 1.02 | — | 4 | 17.8 | 0 |

| Variante | Sonda | 1 en paralelo p50 / p95 (ms) | 5 en paralelo p50 / p95 (ms) | 10 en paralelo p50 / p95 (ms) |
| --- | --- | --- | --- | --- |
| base | GET /login (Next sin Auth ni DB) | 9.7 / 16.4 | 36.9 / 46.6 | 66.6 / 102.2 |
| — | GET /auth/v1/user directo a Kong (inicio) | 55.5 / 65.1 | 110.6 / 152 | 172.5 / 266 |
| — | GET /auth/v1/user directo a Kong (final) | 57.1 / 72.8 | 113.9 / 162.6 | 163.3 / 232.5 |

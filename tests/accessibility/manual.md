# Escenarios manuales de accesibilidad · U-EXP-03

Estado inicial: **pendientes**, salvo las ejecuciones automáticas enlazadas en `docs/accesibilidad.md`. No se ha ejecutado un lector de pantalla real ni Safari/iOS desde Playwright. Registrar fecha, persona, sistema, versión exacta, tecnología de apoyo, tema, ancho/zoom y resultado por paso; un fallo incluye ruta, control, resultado esperado y observado, sin datos personales.

Preparación: `pnpm db:local:bootstrap --profile test`; iniciar `pnpm dev:local --profile test` para el ensayo manual, entrar por «Acceso local de desarrollo» usando las credenciales ficticias mostradas únicamente en la terminal interactiva por `pnpm db:local:credentials --as a --profile test`. Crear un libro «Ensayo manual de accesibilidad» y una estantería «Destino manual». No capturar campos de contraseña ni copiar credenciales al informe. Al terminar, borrar solo esos datos, parar la app y ejecutar `pnpm db:local:down --profile test`.

## Matriz pendiente de ejecución real

| Entorno | Estado | Lo automático no demuestra |
| --- | --- | --- |
| Windows + NVDA + Chrome | Pendiente | Anuncios, lectura y navegación virtual reales |
| Windows + Narrator + Edge | Pendiente | Interoperabilidad real con UI Automation y Edge |
| Edge estable, teclado y zoom nativo | Pendiente | Menús del navegador y rasterización del zoom real |
| Firefox estable, teclado y zoom nativo | Pendiente | Firefox interactivo; el motor automatizado se registra aparte |
| iPhone/iPad + Safari + VoiceOver | Pendiente | Gestos, foco accesible, teclado virtual y barras dinámicas |
| Safari de macOS | Pendiente | Safari distribuido por Apple; WebKit de Playwright es otro producto |

## Escritorio: teclado, NVDA o Narrator

1. Abrir `/login` sin sesión. Con NVDA (Ctrl+Alt+N, configuración habitual) o Narrator (Win+Ctrl+Enter), leer título, encabezado, «Continuar con Google» y grupo de acceso local. Tab hasta Correo, introducir cuenta ficticia; Tab a Contraseña y Entrar. Deben anunciarse etiquetas, tipo de campo y estado ocupado sin leer contraseña en texto claro.
2. Tras entrar, Tab desde el inicio. El primer enlace debe ser «Saltar al contenido»; Enter debe desplazar/enfocar el contenido principal. Recorrer landmarks con D en NVDA (o navegación de landmarks de Narrator): una cabecera, navegación con nombre y un contenido principal por ruta privada. Verificar título de pestaña al abrir un libro.
3. En `/books/add`, llegar al tab «Buscar por ISBN», pulsar flecha derecha y entrar al formulario manual. Completar título, dos autores, editorial, estado y estantería. Añadir/eliminar una fila de autor sin perder ubicación ni orden lógico. Guardar con Enter; debe aparecer la ficha del libro persistido.
4. En `/books/add`, ISBN `123`, Enter. Debe anunciarse **una vez** «El ISBN no es válido…», el campo debe exponerse inválido y conservar su valor. Corregir el ISBN: el error desaparece. Simular una desconexión al guardar y verificar que el borrador permanece y el aviso se anuncia una sola vez.
5. En `/books`, buscar «Ensayo manual». Explorar tabla por encabezados (T y Ctrl+Alt+flechas en NVDA): Título, Autor(es), Páginas, Publicado y Estado. Activar orden por Título dos veces: anunciar ascendente/descendente y mantener foco en el botón. En pantalla estrecha, enfocar «Tabla de libros, desplazamiento horizontal» y desplazar con flechas sin desplazar toda la página lateralmente.
6. Marcar la casilla del libro con Espacio, elegir «Destino manual» en Estantería de destino con flechas, confirmar y activar «Mover 1 libro». Verificar desaparición de selección, persistencia de la ubicación tras recarga y ausencia de controles de lote sin nombre.
7. Abrir la ficha, Tab a Editar ficha, Enter: foco en Título. Cambiarlo y guardar: foco vuelve a Editar ficha; se anuncia el resultado una sola vez. Cancelar otra edición: mismo retorno de foco. El indicador debe verse por completo, fuera de la cabecera fija.
8. En `/shelves`, activar Nueva estantería: anunciar nombre y descripción; foco inicial en Nombre de la estantería. Tab y Shift+Tab deben circular por controles del diálogo sin llegar al fondo. Escape cierra y devuelve foco al disparador. Repetir con Renombrar y confirmación de Eliminar libro (foco inicial en Cancelar). No debe eliminarse nada al abrir/cancelar.
9. En `/shelves/3d`, cambiar estantería, escuchar nombre/recuento/página y abrir un lomo con Enter. Volver restaura la selección y foco del lomo. «Ver en la colección» debe ofrecer la alternativa 2D equivalente. No se anuncia un gesto de cámara inexistente.
10. En `/profile`, leer nombre/correo y editar Nombre. El correo se anuncia como solo lectura. Abrir menú de cuenta con Enter, flechas hasta Cerrar sesión y Enter: acceso anónimo, sin contenido privado tras recargar.
11. En cada recorrido, inspeccionar texto, bordes, selección, hover y foco en ambos temas. Para los incompletos axe, medir con analizador de contraste y muestras del fondo realmente renderizado: textos/etiquetas del login sobre degradado, descripción del diálogo, flecha de orden y lomos 3D; registrar colores, ratio y tamaño de texto. Revisar los `aria-controls` de los disparadores Radix cerrados y abiertos con el lector. No depender del color para identificar errores o selección. Verificar con alto contraste/colores forzados de Windows y registrar cualquier pérdida de indicador.

## Zoom y pantallas

1. Chrome/Edge/Firefox reales: ventana de contenido de 1280×1024, zoom nativo Ctrl+0, Ctrl++ hasta 200 % y 400 %. Registrar `innerWidth/innerHeight` y zoom de la interfaz; la emulación automatizada usa 640×512 y 320×256 CSS respectivamente. No usar `deviceScaleFactor` como sustituto del zoom.
2. En ambos temas recorrer inicio, tabla, cuadrícula, alta ISBN/manual, ficha/edición, estanterías/diálogo, 3D, perfil y login a 320, 375, 768 y 1440 px CSS. Sin scroll horizontal del documento; se permite solo dentro de la región de tabla identificada. Comprobar títulos/ISBN largos, fila seleccionada, validación y menú móvil abierto.
3. A 400 %, abrir Nueva estantería, enfocar último botón con Tab y volver a Nombre con Shift+Tab. El diálogo debe desplazarse por dentro, mantener visibles el foco y los controles y permitir Escape. El menú móvil también debe desplazarse en una ventana baja.
4. Activar «Reducir movimiento» en Windows o macOS y recargar. No debe haber entrada animada de escena ni escalado, giros, spinners o transiciones decorativas perceptibles. Verificar que estados de carga siguen teniendo texto.

## Safari/iOS y VoiceOver

1. En dispositivo físico, activar VoiceOver en Ajustes → Accesibilidad → VoiceOver, abrir Safari y el origen de pruebas autorizado. No publicar el stack local ni modificar firewall para este ensayo sin coordinación específica. Registrar dispositivo, iOS/Safari y acceso seguro usado.
2. Deslizar derecha/izquierda desde login por etiquetas y botones; doble toque para activar. Usar rotor Encabezados, Enlaces y Controles de formulario. Entrar con la cuenta ficticia y comprobar que el cambio de ruta se entiende sin buscar visualmente el foco.
3. En 375 px aproximadamente, abrir menú móvil y navegar a alta; mostrar/ocultar teclado virtual en ISBN y Título. Los controles activos, mensajes y guardar deben seguir alcanzables con barras de Safari expandidas/contraídas y en ambas orientaciones.
4. Completar alta manual, búsqueda, selección/movimiento, edición y cierre de sesión con gestos de VoiceOver. Repetir diálogos: el fondo no debe recibir foco accesible y al cerrar se vuelve al disparador. Probar Select de Radix y select nativo por separado.
5. Tocar lomos 3D y enlace 2D; comprobar que no se requiere hover ni gesto de giro. Aumentar tamaño de texto de iOS y zoom de página de Safari; registrar reflujo y objetivos táctiles. Repetir con movimiento reducido y temas claro/oscuro.

No se afirma certificación WCAG. Una suite axe sin violaciones graves es evidencia de detección automatizada, no de cumplimiento completo ni de experiencia real con lector.

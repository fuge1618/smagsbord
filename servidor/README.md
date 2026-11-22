# Servidor de Smagsbord

Arma las recetas con Gemini aunque la app esté cerrada. Es un Worker de Cloudflare con un Durable Object.

- `POST /recetas` deja un pedido (enlace de YouTube, enlace de una página o texto) y devuelve un `id`.
- `GET /recetas/<id>` dice si está pendiente, lista o si falló.
- Todo pedido lleva el encabezado `X-Codigo` con el código de la familia.

Secretos que se cargan en Cloudflare (nunca en el repositorio):

- `GEMINI_KEY`: clave de Gemini.
- `CODIGO`: código de la familia, el mismo que se escribe en la app.

Los pedidos se borran solos a los 7 días. Máximo 60 recetas por día.

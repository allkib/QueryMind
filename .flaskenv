FLASK_APP=app.py
# Port 5000 is taken by macOS AirPlay Receiver / Control Center, which returns a
# blank/403 page to the browser. Run on 8000 to avoid that conflict.
FLASK_RUN_PORT=8000
# Debug on = auto-reload templates + Python on every edit (dev only; gunicorn in
# prod ignores this file). Without it, Flask caches templates and edits won't show.
FLASK_DEBUG=1

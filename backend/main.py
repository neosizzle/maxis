from flask import Flask, jsonify
from fastapi import FastAPI
from fastapi.middleware.wsgi import WSGIMiddleware

# Flask application
flask_app = Flask(__name__)


@flask_app.get("/")
def flask_home():
    return jsonify(
        framework="Flask",
        message="Hello from Flask!",
    )


@flask_app.get("/health")
def flask_health():
    return jsonify(status="ok", framework="Flask")


# FastAPI application
app = FastAPI(
    title="Flask + FastAPI",
    description="A project using Flask and FastAPI together",
    version="1.0.0",
)


@app.get("/")
async def home():
    return {
        "framework": "FastAPI",
        "message": "Hello from FastAPI!",
    }


@app.get("/api/health")
async def api_health():
    return {"status": "ok", "framework": "FastAPI"}


# Mount Flask under /flask
app.mount("/flask", WSGIMiddleware(flask_app))
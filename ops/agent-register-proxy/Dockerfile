FROM python:3.13-alpine

RUN addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --chown=app:app server.py /app/server.py
USER app

EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]

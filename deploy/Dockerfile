FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY temperance ./temperance
RUN useradd --uid 10001 --create-home temperance && mkdir /data && chown temperance:temperance /data
USER temperance
EXPOSE 8788
ENTRYPOINT ["python", "-m", "temperance.control", "--host", "0.0.0.0", "--data", "/data/control.sqlite3"]

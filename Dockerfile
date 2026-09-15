FROM python:3.11-slim

# DejaVu carries Cyrillic, and pdf_font_name() looks for it. Without this the
# PDF export failed in every container with "не найден шрифт с поддержкой
# русского языка", while the same code worked on a Windows laptop through
# Arial. tini gives the process a real init so SIGTERM from Docker and Render
# reaches Python instead of being swallowed by PID 1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./
ENV NBRAIN_HOST=0.0.0.0
ENV NBRAIN_PORT=8000
ENV NBRAIN_DATA_DIR=/app/data
# Belt and braces with the line-buffering set in server.py: anything printed
# before that runs still has to reach the platform log.
ENV PYTHONUNBUFFERED=1

RUN mkdir -p /app/data

# Запуск от непривилегированного пользователя намеренно отложен. Persistent
# Disk на Render монтируется владельцем root уже после сборки образа, поэтому
# «USER nbrain» здесь привёл бы к отказу в записи в /app/data на живом сервисе.
# Правильное решение — entrypoint, который меняет владельца тома и сбрасывает
# привилегии; его нужно проверить на настоящем Render, а не вслепую.

EXPOSE 8000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "server.py"]

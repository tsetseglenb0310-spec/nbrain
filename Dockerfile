FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./
ENV NBRAIN_HOST=0.0.0.0
ENV NBRAIN_PORT=8000

EXPOSE 8000
CMD ["python", "server.py"]

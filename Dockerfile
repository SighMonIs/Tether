FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Database and QR code image are stored in /data so they persist across container restarts
RUN mkdir -p /data
ENV TETHER_DATA=/data

EXPOSE 5225

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5225"]

# Tether

A self-hosted read-later app. Save links from your browser or iPhone, organise them with tags, and read them when you're ready.

## Features

- Save links via browser or iOS Shortcut
- Organise with colour-coded tags
- Auto-fetches titles and descriptions (YouTube, TikTok, and most sites)
- Card and table view
- Mark as read/unread, favourite links
- Full-text search
- Export and import your data as JSON
- Instagram metadata support via Meta app token

## Installation (Docker)

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) installed

### Quick start

1. **Create a `docker-compose.yml`**

   ```yaml
services:
  tether:
    image: ghcr.io/sighmonis/tether:latest
    ports:
      - "5225:5225"
    volumes:
      - tether-data:/data
    restart: unless-stopped

volumes:
  tether-data:
```

2. **Start the container**

   ```bash
   docker compose up -d
   ```

3. **Open the app**

   Navigate to [http://localhost:5225](http://localhost:5225)

Your data is stored in a Docker volume (`tether-data`) and persists across restarts and image updates.

### Updating

```bash
docker compose pull
docker compose up -d
```

### Stopping

```bash
docker compose down
```

To remove your data as well:

```bash
docker compose down -v
```

## iOS Shortcut

The app includes a setup page that generates a QR code for the iOS Shortcut. Open the app on your phone's browser and go to **Settings** to scan the code. Your phone must be on the same Wi-Fi network as the machine running Tether.

## Configuration

All settings are managed through the Settings page in the app, including:

- **API key** — used to authenticate the iOS Shortcut
- **Instagram metadata** — optional Meta app token to fetch titles for Instagram links
- **Metadata refresh** — re-fetch titles and descriptions for all saved links

## Running without Docker

Requires Python 3.12+.

```bash
pip install -r requirements.txt
python main.py
```

The app will be available at [http://localhost:5225](http://localhost:5225).

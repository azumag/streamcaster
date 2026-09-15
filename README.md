# StreamCaster

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node.js-18%2B-green.svg)
![Docker](https://img.shields.io/badge/docker-required-blue.svg)
![FFmpeg](https://img.shields.io/badge/ffmpeg-required-red.svg)

**StreamCaster** is a professional-grade UDP-to-RTMP streaming system that enables dynamic video switching without interrupting live streams. Perfect for content creators, live streaming setups, and broadcast applications.

🚀 **Now with automated CI/CD deployment!** Push to main branch and watch your changes deploy automatically to AWS Lightsail. Enhanced with concurrency control and Terraform state lock protection. Last updated: 2025-06-06 18:28 JST

## ✨ Key Features

- 🎥 **Dynamic Video Switching** - Change videos seamlessly during live streams
- ☁️ **Google Drive Integration** - Stream videos directly from Google Drive folders
- 🌐 **Web-based Control Panel** - Intuitive browser interface for stream management
- 📡 **Multiple Platform Support** - Stream to Twitch, YouTube, Facebook Live, and custom RTMP servers
- 🔄 **Zero-Downtime Switching** - Switch videos without dropping the RTMP connection
- 📊 **Real-time Monitoring** - Live status updates, resource monitoring, and health checks
- 🐳 **Docker-based Architecture** - Containerized for easy deployment and scaling
- 🧪 **Comprehensive Testing** - Full test suite with CI/CD pipeline
- 📚 **RESTful API** - Complete API for programmatic control
- 🛡️ **Production Ready** - Built for reliability and performance

## 🏗️ Architecture

StreamCaster uses a multi-container architecture for optimal performance and reliability:

```marmaid
graph TD
    A[Controller] -->|UDP Stream| B[Receiver]
    B -->|RTMP| C[RTMP Server]
    C -->|Pull| D[OBS]
    C -->|Pull| F[Relay]
    F -->|再エンコード + Push| G[配信先]
    
    subgraph "ストリーミングシステム"
        A
        B
        C
        F
    end
    
    subgraph "外部システム"
        D
        E
        G
    end
    
    style A fill:#e1f5fe
    style B fill:#e8f5e8
    style C fill:#fff3e0
    style F fill:#fce4ec
```

### Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| **Controller** | Web UI, API, Process Management | Node.js + Express |
| **Receiver** | UDP to RTMP conversion | FFmpeg |
| **Relay** | Dynamic video switching | FFmpeg |
| **RTMP Server** | Local testing server | Nginx + RTMP module |

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- 4GB+ RAM
- 2+ CPU cores
- 10GB+ disk space

### 1. Clone & Setup

```bash
git clone https://github.com/azumag/streamcaster.git
cd streamcaster

# Install dependencies
npm install

# Prepare video directory
mkdir -p videos
cp your-videos/* videos/
```

### 2. Start Services

```bash
# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f
```

### 3. Access Web Interface

- **Control Panel**: http://localhost:8080
- **RTMP Stats**: http://localhost:8081/stat

### 4. Start Streaming

1. Open the web interface
2. Select a video file
3. Click "Start Streaming"
4. Stream URL: `rtmp://localhost:1935/live/stream`

## 📦 Installation

### Development Setup

```bash
# Clone repository
git clone https://github.com/azumag/streamcaster.git
cd streamcaster

# Install Node.js dependencies
npm install

# Install controller dependencies
cd controller
npm install

# Run tests
npm test

# Start development server
npm run dev
```

### Production Deployment

```bash
# Create production environment file
cp .env.example .env.production

# Edit configuration
vim .env.production

# Deploy with production settings
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Manual Installation

```bash
# Install system dependencies
sudo apt update
sudo apt install ffmpeg docker.io docker-compose nodejs npm

# Clone and setup project
git clone https://github.com/azumag/streamcaster.git
cd streamcaster
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start services
docker-compose up -d
```

## 🎮 Usage

### Web Interface

The web interface provides complete control over your streaming setup:

#### Dashboard Features
- **Live Status Display** - Current streaming status and video
- **Video Library** - Browse and manage your video files
- **Stream Controls** - Start, stop, and switch streams
- **Real-time Monitoring** - CPU, memory, and network usage
- **Log Viewer** - Real-time system logs

#### Basic Operations

1. **Start Streaming**
   - Select video from library
   - Click "Start Stream"
   - Monitor status in dashboard

2. **Switch Videos**
   - Select new video while streaming
   - Click "Switch" for seamless transition
   - No stream interruption

3. **Stop Streaming**
   - Click "Stop Stream"
   - Safely terminates all processes

### API Usage

Complete RESTful API for programmatic control:

#### Stream Control

```bash
# Get current status
curl http://localhost:8080/api/status

# List available videos
curl http://localhost:8080/api/videos

# Start/switch video
curl -X POST http://localhost:8080/api/switch \
  -H "Content-Type: application/json" \
  -d '{"video": "your-video.mp4"}'

# Stop streaming
curl -X POST http://localhost:8080/api/stop

# Health check
curl http://localhost:8080/api/health
```

#### Response Examples

```json
// GET /api/status
{
  "stream_status": "streaming",
  "current_video": "demo.mp4",
  "process_status": {
    "udp_streaming_running": true,
    "udp_sender_pid": 1234
  },
  "timestamp": "2024-06-05T12:00:00.000Z"
}

// GET /api/videos
{
  "videos": [
    {
      "filename": "demo.mp4",
      "size": 52428800,
      "modified": "2024-06-05T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

### Command Line Tools

```bash
# Health monitoring
./scripts/health_check.sh

# Manual process control
./scripts/start_sender.sh video.mp4
./scripts/stop_sender.sh

# Container management
docker-compose restart receiver
docker-compose logs controller
```

## ⚙️ Configuration

### Environment Variables

Create `.env` file with your configuration:

```bash
# RTMP Configuration
RTMP_SERVER=rtmp://live.twitch.tv/live
STREAM_KEY=your_stream_key_here

# Google Drive Configuration
GOOGLE_DRIVE_API_KEY=your_google_drive_api_key_here
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_REFRESH_TOKEN=your_refresh_token_here

# Network Settings
UDP_PORT=1234
HTTP_PORT=8080
RTMP_PORT=1935

# Resource Limits
CONTROLLER_CPU_LIMIT=0.5
RECEIVER_CPU_LIMIT=1.0
CONTROLLER_MEMORY_LIMIT=512m
RECEIVER_MEMORY_LIMIT=1g
MAX_DOWNLOAD_SIZE=1073741824
TEMP_FILE_TTL=3600000

# Logging
LOG_LEVEL=info
TZ=Asia/Tokyo

# Docker Settings
COMPOSE_PROJECT_NAME=streamcaster
DOCKER_BUILDKIT=1
```

### Platform-Specific Configurations

#### Twitch
```bash
RTMP_SERVER=rtmp://live.twitch.tv/live
STREAM_KEY=live_1234567890_abcdefghijklmnop
```

#### YouTube Live
```bash
RTMP_SERVER=rtmp://a.rtmp.youtube.com/live2
STREAM_KEY=your-youtube-stream-key
```

#### Facebook Live
```bash
RTMP_SERVER=rtmp://live-api-s.facebook.com:80/rtmp
STREAM_KEY=your-facebook-stream-key
```

#### Custom RTMP Server
```bash
RTMP_SERVER=rtmp://your-server.com/live
STREAM_KEY=your-custom-key
```

### Google Drive Setup

To enable Google Drive functionality, you need to set up Google Drive API access:

#### Option 1: API Key (Public Folders Only)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google Drive API
4. Create an API key in Credentials
5. Set the API key in your environment:
```bash
GOOGLE_DRIVE_API_KEY=your_api_key_here
```

#### Option 2: OAuth Credentials (Private Folders)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Google Drive API
3. Create OAuth 2.0 credentials (Desktop application)
4. Download the credentials JSON file
5. Use a tool like Google's OAuth Playground to get a refresh token
6. Configure all OAuth settings:
```bash
GOOGLE_CLIENT_ID=your_client_id_here
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REFRESH_TOKEN=your_refresh_token_here
```

#### Using Google Drive
1. Share your Google Drive folder publicly (for API key) or ensure OAuth access
2. Copy the folder URL or ID
3. In the web interface, switch to the "Google Drive" tab
4. Paste the folder link and click "ファイルリスト取得"
5. Select videos from the list to stream

### Video Settings

Supported formats and recommended settings:

| Setting | Recommended | Supported |
|---------|-------------|-----------|
| **Container** | MP4 | MP4, MOV, AVI, MKV |
| **Video Codec** | H.264 | H.264, H.265 |
| **Audio Codec** | AAC | AAC, MP3 |
| **Resolution** | 1920x1080 | Any |
| **Framerate** | 30fps | 24-60fps |
| **Bitrate** | 2-6 Mbps | 1-50 Mbps |

### Optimal Encoding Settings for System Stability

To achieve maximum stability across all system components (Controller → Receiver → RTMP Server → Relay), use these specific encoding settings:

#### Recommended FFmpeg Command
```bash
ffmpeg -i input.mp4 \
  -c:v libx264 -preset medium -crf 21 \
  -maxrate 4000k -bufsize 8000k \
  -pix_fmt yuv420p -profile:v high -level 4.0 \
  -r 30 -g 60 -keyint_min 30 -sc_threshold 0 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30" \
  -aspect 16:9 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 -profile:a aac_low \
  -movflags +faststart \
  output.mp4
```

#### Setting Details

**Video Configuration:**
- **Codec**: `libx264` - Maximum compatibility across all components
- **Preset**: `medium` - Balance between encoding speed and quality
- **CRF**: `21` - High quality constant rate factor
- **Rate Control**: `maxrate 4000k -bufsize 8000k` - Prevents UDP overflow
- **Pixel Format**: `yuv420p` - Universal compatibility
- **Profile/Level**: `high@4.0` - Optimal for streaming platforms
- **Frame Rate**: `30fps` - Stable UDP transmission
- **GOP**: `60 frames (2s)` - Good seek performance and stability
- **Scene Detection**: Disabled (`-sc_threshold 0`) - Predictable bitrate

**Audio Configuration:**
- **Codec**: `aac` - Standard for RTMP streaming
- **Bitrate**: `192k` - High quality audio
- **Sample Rate**: `48000Hz` - Broadcast standard
- **Channels**: `2` (stereo) - Standard configuration
- **Profile**: `aac_low` - Maximum compatibility

**Video Processing:**
- **Resolution**: Normalized to 1920x1080 with black padding
- **Aspect Ratio**: Forced to 16:9 for consistent output
- **Scaling**: Maintains original aspect ratio, adds black bars if needed

#### Why These Settings?

- **Controller (UDP Sender)**: Fixed frame rate and bitrate limits ensure stable UDP transmission
- **Receiver (UDP to RTMP)**: Standard H.264 profile ensures reliable decoding
- **RTMP Server**: Level 4.0 and AAC Low profile are universally supported
- **Relay (Re-streaming)**: Consistent 1920x1080 output simplifies relay processing

These settings prioritize system stability over file size optimization and are specifically tuned for real-time streaming workflows.

## 📡 API Reference

### Stream Management

#### GET /api/status
Returns current streaming status and system information.

**Response:**
```json
{
  "stream_status": "streaming|stopped|error",
  "current_video": "filename.mp4|null",
  "process_status": {
    "udp_streaming_running": boolean,
    "udp_sender_pid": number|null
  },
  "timestamp": "ISO-8601-datetime"
}
```

#### POST /api/switch
Start streaming or switch to a different video.

**Request (Local File):**
```json
{
  "video": "filename.mp4",
  "source": "local"
}
```

**Request (Google Drive):**
```json
{
  "video": "filename.mp4",
  "source": "googledrive",
  "googledriveFileId": "file_id_from_google_drive"
}
```

**Response:**
```json
{
  "success": boolean,
  "message": "string",
  "video": "filename.mp4",
  "source": "local|googledrive",
  "status": "streaming"
}
```

#### POST /api/stop
Stop current streaming session.

**Response:**
```json
{
  "success": boolean,
  "message": "Stream stopped successfully"
}
```

### Video Management

#### GET /api/videos
List all available video files.

**Response:**
```json
{
  "videos": [
    {
      "filename": "video.mp4",
      "size": 52428800,
      "modified": "2024-06-05T10:30:00.000Z"
    }
  ],
  "count": 1
}
```

### Google Drive Management

#### POST /api/googledrive/files
Get video files from a Google Drive folder.

**Request:**
```json
{
  "folderLink": "https://drive.google.com/drive/folders/folder_id"
}
```

**Response:**
```json
{
  "success": boolean,
  "files": [
    {
      "id": "file_id",
      "filename": "video.mp4",
      "size": 52428800,
      "modified": "2024-06-05T10:30:00.000Z"
    }
  ],
  "count": 1,
  "folderId": "folder_id"
}
```

#### GET /api/googledrive/status
Check Google Drive authentication status and temporary files.

**Response:**
```json
{
  "authenticated": boolean,
  "tempDir": {
    "fileCount": 3,
    "totalSize": 157286400,
    "totalSizeMB": "150.00"
  },
  "timestamp": "ISO-8601-datetime"
}
```

#### POST /api/googledrive/cleanup
Clean up temporary Google Drive files.

**Response:**
```json
{
  "success": boolean,
  "message": "Cleanup completed"
}
```

### System Monitoring

#### GET /api/health
System health check endpoint.

**Response:**
```json
{
  "status": "healthy|unhealthy",
  "udp_process": boolean,
  "timestamp": "ISO-8601-datetime"
}
```

### Error Responses

All endpoints return standardized error responses:

```json
{
  "success": false,
  "error": "Error description",
  "code": "ERROR_CODE"
}
```

**Common Error Codes:**
- `VIDEO_NOT_FOUND` - Specified video file doesn't exist
- `PROCESS_START_FAILED` - Failed to start streaming process
- `INVALID_REQUEST` - Malformed request data
- `SYSTEM_ERROR` - Internal system error

## 🛠️ Development

### Project Structure

```
streamcaster/
├── controller/                 # Node.js controller service
│   ├── __tests__/             # Test files
│   ├── templates/             # Web UI templates
│   ├── controller.js          # Main application
│   ├── process_manager.js     # Process management
│   ├── google_drive_manager.js # Google Drive integration
│   └── package.json           # Dependencies
├── scripts/                   # Utility scripts
│   ├── health_check.sh        # Health monitoring
│   ├── start_sender.sh        # Process control
│   └── stop_sender.sh         # Process control
├── rtmp-server/               # Local RTMP server
├── videos/                    # Video file storage
├── logs/                      # Application logs
├── .env.example               # Environment configuration template
├── docker-compose.yml         # Docker configuration
└── README.md                  # This file
```

### Development Workflow

```bash
# Start development environment
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Check code quality
npm run lint

# Fix linting issues
npm run lint:fix

# Run full CI pipeline
npm run ci
```

### Testing

StreamCaster includes comprehensive test coverage:

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run specific test file
npm test -- controller.test.js

# Run tests in watch mode
npm run test:watch
```

**Test Categories:**
- Unit tests for individual components
- Integration tests for API endpoints
- End-to-end tests for complete workflows
- Performance tests for resource usage

### Code Quality

We maintain high code quality standards:

- **ESLint** - Code style and error checking
- **Jest** - Comprehensive testing framework
- **GitHub Actions** - Automated CI/CD pipeline
- **Husky** - Pre-commit hooks for quality gates

### Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Make changes and add tests
4. Run quality checks: `npm run ci`
5. Commit changes: `git commit -m 'Add amazing feature'`
6. Push to branch: `git push origin feature/amazing-feature`
7. Create Pull Request

## 🚀 Deployment

### Production Environment

For production deployment, use the production compose file:

```bash
# Create production environment
cp .env.example .env.production

# Configure production settings
vim .env.production

# Deploy with production optimizations
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Production Checklist

- [ ] Set secure RTMP server credentials
- [ ] Configure resource limits appropriately
- [ ] Set up log rotation
- [ ] Configure firewall rules
- [ ] Set up monitoring and alerting
- [ ] Configure backup strategy
- [ ] Test failover procedures

### Scaling Considerations

For high-volume streaming scenarios:

```yaml
# docker-compose.scale.yml
version: '3.8'
services:
  receiver:
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '2'
          memory: 2g
```

### Load Balancing

For multiple streaming destinations:

```bash
# Start multiple receivers
docker-compose up -d --scale receiver=3

# Configure load balancer
# See nginx.conf.example for configuration
```

## 📊 Monitoring & Troubleshooting

### Health Monitoring

Built-in health check system:

```bash
# Manual health check
./scripts/health_check.sh

# Continuous monitoring
./scripts/health_check.sh --watch

# Docker health checks
docker-compose ps
```

### Log Analysis

Comprehensive logging for troubleshooting:

```bash
# View all logs
docker-compose logs

# Follow specific service logs
docker-compose logs -f controller
docker-compose logs -f receiver

# Filter by timestamp
docker-compose logs --since="2024-06-05T10:00:00"

# Export logs for analysis
docker-compose logs > streamcaster.log
```

### Performance Monitoring

Monitor system resources:

```bash
# Container resource usage
docker stats

# System resource usage
top
htop
iotop

# Network monitoring
netstat -tlnp
ss -tlnp
```

### Common Issues & Solutions

#### Stream Won't Start
```bash
# Check video file permissions
ls -la videos/

# Verify Docker containers are running
docker-compose ps

# Check FFmpeg processes
ps aux | grep ffmpeg

# Review controller logs
docker-compose logs controller
```

#### High CPU Usage
```bash
# Check resource limits
docker-compose config

# Monitor container resources
docker stats

# Adjust CPU limits in docker-compose.yml
```

#### Network Issues
```bash
# Check port availability
netstat -tlnp | grep 8080
netstat -tlnp | grep 1935

# Test RTMP connectivity
ffmpeg -f lavfi -i testsrc -f flv rtmp://your-server/live/key

# Verify Docker network
docker network ls
docker network inspect streamcaster_streaming-network
```

### Recovery Procedures

Automated recovery for common failures:

```bash
# Complete system restart
docker-compose down
docker-compose up -d

# Clean restart with rebuild
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d

# Reset to known good state
git pull origin main
docker-compose down -v
docker-compose up -d --build
```

## 📈 Performance & Scaling

### System Requirements

#### Minimum Requirements
- **CPU**: 2 cores
- **RAM**: 2GB
- **Storage**: 10GB
- **Network**: 10 Mbps upload

#### Recommended Production
- **CPU**: 4+ cores
- **RAM**: 8GB+
- **Storage**: 100GB+ SSD
- **Network**: 50+ Mbps upload

### Performance Optimization

#### Video Encoding
```bash
# Optimize video files for streaming
ffmpeg -i input.mp4 \
  -c:v libx264 -preset medium -crf 23 \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  output.mp4
```

#### Container Optimization
```yaml
# Optimized resource allocation
services:
  controller:
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 512M
        reservations:
          cpus: '0.2'
          memory: 256M
```

### Scaling Strategies

#### Horizontal Scaling
- Multiple receiver containers
- Load balancing across streams
- Geographic distribution

#### Vertical Scaling  
- Increased CPU/memory allocation
- High-performance storage
- Dedicated network interfaces

## 🔒 Security

### Security Best Practices

#### Network Security
- Use private networks for internal communication
- Implement firewall rules for external access
- Use VPN for remote management
- Regular security updates

#### Access Control
```bash
# Restrict web interface access
# Configure nginx proxy with authentication

# Secure RTMP endpoints
# Use strong stream keys
# Implement IP whitelisting
```

#### Data Protection
- Encrypt RTMP streams when possible
- Secure video file storage
- Regular backup procedures
- Access logging and monitoring

### Production Security Checklist

- [ ] Change default passwords/keys
- [ ] Configure HTTPS for web interface
- [ ] Set up proper firewall rules
- [ ] Enable audit logging
- [ ] Regular security updates
- [ ] Backup and recovery testing
- [ ] Access control implementation

## ❓ FAQ

### General Questions

**Q: Can I stream to multiple platforms simultaneously?**
A: Yes, you can configure multiple receiver containers for different platforms. See the scaling section for details.

**Q: What video formats are supported?**
A: Any format supported by FFmpeg (MP4, MOV, AVI, MKV, etc.). H.264/AAC is recommended for best compatibility.

**Q: Is there a limit to video file size?**
A: No hard limit, but consider storage space and network bandwidth for large files.

### Technical Questions

**Q: Can I use this without Docker?**
A: Yes, but Docker is highly recommended. Manual installation requires FFmpeg, Node.js, and proper process management.

**Q: How do I add custom FFmpeg parameters?**
A: Modify the process_manager.js file or create custom scripts in the scripts/ directory.

**Q: Can I run this on ARM processors (Raspberry Pi)?**
A: Yes, but performance may be limited. Use ARM-compatible Docker images.

### Troubleshooting

**Q: Stream is choppy or has artifacts**
A: Check CPU usage, reduce video bitrate, or increase hardware resources.

**Q: Web interface is not accessible**
A: Verify port 8080 is not blocked and the controller container is running.

**Q: RTMP connection fails**
A: Verify stream key and server URL. Check network connectivity and firewall rules.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Contributors

- **Development Team** - Core system architecture and implementation
- **Community** - Bug reports, feature requests, and testing

## 🔗 Related Projects

- [FFmpeg](https://ffmpeg.org/) - Multimedia processing library
- [Nginx RTMP Module](https://github.com/arut/nginx-rtmp-module) - RTMP server implementation
- [OBS Studio](https://obsproject.com/) - Broadcasting software
- [Node Media Server](https://github.com/illuspas/Node-Media-Server) - Node.js RTMP server

## 📞 Support

- **Documentation**: This README and inline code comments
- **Issues**: [GitHub Issues](https://github.com/azumag/streamcaster/issues)
- **Discussions**: [GitHub Discussions](https://github.com/azumag/streamcaster/discussions)

---

**StreamCaster** - Professional streaming made simple. 🎬✨
## BLMF 2026 control plane

The 2026 BLMF architecture keeps StreamCaster out of the media path. Sub OBS is the single entry-video playback clock, sends the venue feed directly to VRCDN, and exposes a high-quality Full NDI feed to Main OBS. Main OBS switches between the VRChat venue and the NDI entry feed while Twitch/YouTube outputs remain persistent.

The new control plane is disabled by default with `BLMF_ENABLED=false`. When enabled, it provides:

- authenticated control of separate Main/Sub OBS websocket sessions;
- one active Director lease for normal production commands;
- backup `PANIC` access for authorized operators;
- stale/duplicate/out-of-order command rejection;
- a local VRChat OSC operator bridge that can work remotely over Tailscale;
- fail-closed TAKE behavior until asset, VRCDN, and NDI readiness are proven.

See `docs/superpowers/specs/2026-09-08-blmf-2026-architecture-design.md` for the architecture and `docs/blmf/operator-bridge.md` for remote-operator setup and rehearsal.

## BLMF Windows local PoC

The reproducible two-OBS setup, Web/OSC controller, media progress and reconnect UI are documented in [tools/blmf-windows-poc](tools/blmf-windows-poc/README.md). This is an isolated PoC; credentials and live OBS configuration are not stored in Git.

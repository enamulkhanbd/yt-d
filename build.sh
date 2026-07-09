#!/usr/bin/env bash
# exit on error
set -o errexit

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Download and install ffmpeg binary in the build environment
echo "Downloading FFmpeg..."
mkdir -p bin
curl -L https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz -o ffmpeg.tar.xz
tar -xf ffmpeg.tar.xz --strip-components=1
mv bin/ffmpeg bin/ffprobe .
rm -rf ffmpeg-master-* ffmpeg.tar.xz
chmod +x ffmpeg ffprobe
echo "FFmpeg installed successfully!"

#!/usr/bin/env bash
# exit on error
set -o errexit

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt

# Download and install ffmpeg binary in the build environment
echo "Downloading FFmpeg..."
curl -L https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz -o ffmpeg.tar.xz

echo "Extracting FFmpeg..."
mkdir -p ffmpeg_temp
tar -xf ffmpeg.tar.xz -C ffmpeg_temp --strip-components=1

echo "Moving binaries..."
mv ffmpeg_temp/bin/ffmpeg ./ffmpeg
mv ffmpeg_temp/bin/ffprobe ./ffprobe

echo "Cleaning up..."
rm -rf ffmpeg_temp ffmpeg.tar.xz

chmod +x ffmpeg ffprobe
echo "FFmpeg installed successfully!"

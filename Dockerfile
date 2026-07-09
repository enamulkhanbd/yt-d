# Use an official Python runtime as a parent image
FROM python:3.12-slim

# Install system dependencies, including ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /code

# Copy requirements and install python packages
COPY ./requirements.txt /code/requirements.txt
RUN pip install --no-cache-dir --upgrade -r /code/requirements.txt

# Copy the rest of the application code
COPY . /code

# Set permissions for the temporary folder (Hugging Face runs as user 1000)
RUN mkdir -p /code/temp && chmod 777 /code/temp

# Run the application (Hugging Face Spaces expects the app on port 7860)
CMD ["python", "-m", "uvicorn", "api.index:app", "--host", "0.0.0.0", "--port", "7860"]

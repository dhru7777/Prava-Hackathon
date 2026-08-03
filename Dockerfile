# MilkWatch — Part1 UI + Part2 Linq agent + Part3 Prava (one public URL)
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl ca-certificates \
    libglib2.0-0 libsm6 libxext6 libxrender1 libgl1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY part2_linq/package.json part2_linq/package-lock.json ./part2_linq/
COPY part3_prava/package.json part3_prava/package-lock.json ./part3_prava/
RUN cd part2_linq && npm ci \
  && cd ../part3_prava && npm ci

COPY part1_vision/requirements.txt ./part1_vision/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages \
      fastapi uvicorn python-dotenv requests Pillow openai anthropic \
    && pip3 install --no-cache-dir --break-system-packages "opencv-python-headless>=4.10.0"

COPY part1_vision ./part1_vision
COPY part2_linq ./part2_linq
COPY part3_prava ./part3_prava
COPY scripts/start-railway.sh ./scripts/start-railway.sh
RUN chmod +x ./scripts/start-railway.sh \
  && cd part2_linq && npm ci \
  && cd ../part3_prava && npm ci

ENV HOST=0.0.0.0
ENV PART2_API=http://127.0.0.1:8787
ENV PART3_API=http://127.0.0.1:8788
ENV NODE_ENV=production

EXPOSE 8080
CMD ["./scripts/start-railway.sh"]

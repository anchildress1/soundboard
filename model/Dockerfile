# Google's official quantization-aware (QAT) Q4_0 build of Gemma 4 12B-it, pinned to a repo revision
# and verified by checksum before it reaches the runtime image.
FROM curlimages/curl:8.22.0@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777 AS weights
ARG HF_REPO=https://huggingface.co/google/gemma-4-12B-it-qat-q4_0-gguf/resolve/29d097773436b69ff9feafd636ab4cf873786537
# curlimages/curl runs as curl_user; its home is the one directory that user can write.
WORKDIR /home/curl_user
RUN curl -fsSL -o model.gguf "$HF_REPO/gemma-4-12b-it-qat-q4_0.gguf" \
  && curl -fsSL -o mmproj.gguf "$HF_REPO/mmproj-gemma-4-12b-it-qat-q4_0.gguf" \
  && printf '%s  %s\n' \
    93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b model.gguf \
    cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7 mmproj.gguf \
    | sha256sum -c -

# Weights are baked in: a cold start reads them from local disk instead of pulling ~7 GB while the
# GPU bills.
FROM ghcr.io/ggml-org/llama.cpp:server-cuda-v0.5.0@sha256:52192a23c7b258044463aebba78826cdff39a7393b713edc313324b343a7b836
# Not /models: Vertex AI serving leaves that directory empty at runtime.
COPY --from=weights /home/curl_user/model.gguf /home/curl_user/mmproj.gguf /opt/gemma/
# Vertex AI serves on GKE, which mounts the NVIDIA driver at /usr/local/nvidia/lib64; without it
# on the library path llama-server finds no GPU. Thinking is capped at 1024 tokens: every token is
# billed GPU time.
ENV LD_LIBRARY_PATH=/usr/local/nvidia/lib64:/usr/local/cuda/lib64 \
    LLAMA_ARG_MODEL=/opt/gemma/model.gguf \
    LLAMA_ARG_MMPROJ=/opt/gemma/mmproj.gguf \
    LLAMA_ARG_PORT=8081 \
    LLAMA_ARG_N_GPU_LAYERS=999 \
    LLAMA_ARG_CTX_SIZE=8192 \
    LLAMA_ARG_N_PARALLEL=1 \
    LLAMA_ARG_THINK_BUDGET=1024
EXPOSE 8081

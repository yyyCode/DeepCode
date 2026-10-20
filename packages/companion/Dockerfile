# 平台版镜像。构建上下文是仓库根：pnpm workspace 里的共享包要一起进来。
FROM node:22-slim

# sherpa-onnx 的 ONNX Runtime 依赖 libgomp；slim 镜像里没有。
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.33.0

WORKDIR /app

# 先拷全量再装：workspace 的 lockfile 与各包清单缺一不可。
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @deepcode/companion build

ENV NODE_ENV=production \
    PORT=3001 \
    DEEPCODE_HOST=0.0.0.0 \
    DEEPCODE_COMPANION_DB=/data/companion.db

EXPOSE 3001
VOLUME ["/data"]

# 直接跑 TS 源文件（包内用 tsx）；cloud 入口才启用账号、额度与管理接口。
CMD ["pnpm", "--filter", "@deepcode/companion", "start:cloud"]

#!/usr/bin/env bash
# 사용: run-postflop.sh <shard> <shards>
k=$1; K=$2
for m in btn-bb-srp co-bb-srp sb-bb-srp bb-btn-3bp; do
  node --max-old-space-size=3000 .cache/gen-postflop.mjs $m $k $K 100 0.2
done

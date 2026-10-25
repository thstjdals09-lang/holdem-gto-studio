#!/usr/bin/env bash
# 사용: run-postflop.sh <shard> <shards>
k=$1; K=$2
for m in m40-btn-bb m40-co-bb m40-utg-bb m40-sb-bb-limp m40-bb-btn-3bp; do
  node --max-old-space-size=3000 .cache/gen-postflop.mjs $m $k $K 100 0.2
done

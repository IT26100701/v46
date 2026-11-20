"use strict";

var NCBP5Bp = Object.create(null);
function fn(ratk_V) {
  const seren = "Hello";
  const BEpnjL = "!";
  return seren + ", " + ratk_V + BEpnjL;
}
function NwomVo(items) {
  const ratk_V = 198;
  let seren2 = 0;
  for (let BEpnjL = 0; BEpnjL < items.length; BEpnjL++) {
    seren2 += items[BEpnjL] * 1.1 + 0.05;
  }
  return Math.round(seren2 * 100) / 100;
}
function seren(seren3, ratk_V) {
  const seren4 = payload.apiUrl + "/" + seren3;
  const BEpnjL = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + payload.token
  };
  if (ratk_V === "GET") {
    return {
      url: seren4,
      headers: BEpnjL,
      timeout: payload.timeout
    };
  }
  return {
    url: seren4,
    headers: BEpnjL,
    body: JSON.stringify({
      retries: payload.maxRetries
    }),
    timeout: payload.timeout
  };
}
function Nh4NVjm() {}
const payload = {
  apiUrl: "https://api.example.com/v2",
  token: "sk_live_9f8a7b6c5d4e3f2a1b0c",
  maxRetries: 3,
  timeout: 30000,
  debug: false
};
class ratk_V {
  constructor(NCBP5Bp) {
    this.base = NCBP5Bp;
    this.calls = 0;
  }
  async get(NCBP5Bp) {
    this.calls++;
    return seren(NCBP5Bp, "GET");
  }
  async post(NCBP5Bp, Nh4NVjm) {
    this.calls++;
    return seren(NCBP5Bp, "POST");
  }
}
const store = new ratk_V(payload.apiUrl);
async function BEpnjL() {
  const NCBP5Bp = [10, 20, 30, 40, 50];
  const Nh4NVjm = NwomVo(NCBP5Bp);
  const ratk_V = fn("world");
  const BEpnjL = await store.get("users/123");
  console.log(ratk_V, Nh4NVjm, JSON.stringify(BEpnjL), payload.debug ? "on" : "off");
  return {
    total: Nh4NVjm,
    hello: ratk_V,
    calls: store.calls
  };
}
module.exports = {
  main: BEpnjL,
  greeting: fn,
  computeTotal: NwomVo,
  ApiClient: ratk_V,
  CONFIG: payload
};
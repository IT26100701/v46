"use strict";

function __p_dZMW_MAIN_STR_decode(seren3) {
  var table = "%G?Ap`#46:ZXEeIB>SL5W*@$2x)FYsz;^l&jiK|mUy,!n/<kDQ8v+bHgw_TcorP{0\"]9O3JR=at}d(M[.h71~fuqVCN";
  var raw = "" + (seren3 || "");
  var len = raw.length;
  var items = [];
  var seren = 0;
  var seren4 = 0;
  var seren5 = -1;
  for (var index = 0; index < len; index++) {
    var seren2 = table.indexOf(raw[index]);
    if (seren2 === -1) {
      continue;
    }
    if (seren5 < 0) {
      seren5 = seren2;
    } else {
      seren5 += seren2 * 91;
      seren |= seren5 << seren4;
      seren4 += (seren5 & 8191) > 88 ? 13 : 14;
      do {
        items.push(seren & 255);
        seren >>= 8;
        seren4 -= 8;
      } while (seren4 > 7);
      seren5 = -1;
    }
  }
  if (seren5 > -1) {
    items.push((seren | seren5 << seren4) & 255);
  }
  return __p_5Xtq_bufferToString(items);
}
function fn(start, length) {
  return __p_dZMW_MAIN_STR_decode(__p_ZmUY_array.slice(start, start + length));
}
var __p_ZmUY_array = "ILQaqNN`tDB}in8V>vGu8]#aPIF~~Z`_^q\"hWhy#}Cq3{RqP(J`O2bSClK>yH1?CxsV+y,}bNi{jR59.O1kR]OAX>%V~&6RM[ChdBBu$arrQ#9O/fh>Cn[p2U),lVj8\".<(Te/av\"\"vK1`{TkT5qq%EGr\"?O^cl++Bn(#;*#{h4\"pn|V^06X6Ndx|&/(j4<J;K.&?Cl{VF6nK_*ZShxG,p\",Q6ItGG(=9a]_O#;#[&?>w$xEt/U*dqdAGJz2)E!!u;T(%!/c5^j6et]z##&RC6&O,E#*ny?EFA:{p(i:5A[r3vp;`3fS#+OT/QGpHg$R8?of,+)mdYE0H)X^;M+?)=o@SBBI;3=%AGiu~sS\"ZHs*cNGHu&$BW(Mh)?Lj*OUy!zg_J%^Hju0HS])78_0T|+j:Py{Z]\"e_$J(bwbw4c]#Do_[bxqva76>PMEH\"2(<zB;!h!=/u+Y&R)34_$<XP|=D$grD9_s#Y+~2O?74_C8hqq1?NP,I=EP~yw3*{B90.t#%mz<[l(A_=#i@.^8E)WdqUkpu8ixsd|5$A]hg=y*r$gp74_Em?C</qv?vFKt(Aa$)YP:_gQMKTR/5Zrtx~De_[6^*EV!x^7._uXlZ2BX6p>!BQ)?32_hAc^xh:}[zzA>twY^F4xLB*Zw!_du&9QWY1{|ZH\"x43b$ckj:m!eZsKL)LHsY4ld)qt0:B0?n<!`Z_J%_Iq*%y@X>g,{_Qn/za1bB=NK,f+H&8De|NAF5>l;Rk6\"HGuZgS?cka*U@q[F8;)W%%KIEkY+86|5*Y5beAA{GcrYh^EFnuox%65t.Y`a=#:,a65+zYU&0u_Oi(!.8?&4u=GpxHF0IghNJv|;MhY?1aKX)!w:H78?W>(l&_R:QO&?A]/RdEdY?LmRr2/U*Z+)/rf,hvDvvGV58ubvl9aV4eGFZlJhAcBd9yiQgMiEwavTL1zvx8kjeiVPVruI3pHjNXKJaFfpnd9T6O1MDMNgu5gnEMwg86SAaGDsnyMc5nHmGUCC4a6hNXUXs0zGSIPuxXUcfsFD7eKcJH4HC2T235xl2pYUdVduYTiLfXjDoGFBRqknfZcbJdIPlYpgsTnOia1UFBqupdHicZRxcarsWqRAvbloAE5q5CFF4x";
function __p_zw4R_getGlobal() {
  var array = [function () {
    return globalThis;
  }, function () {
    return global;
  }, function () {
    return window;
  }, function () {
    return new Function("return this")();
  }];
  var bestMatch;
  var itemsToSearch = [];
  try {
    bestMatch = Object;
    itemsToSearch.push("".__proto__.constructor.name);
  } catch (seren3) {}
  genVar1: for (var index2 = 0; index2 < array.length; index2++) {
    try {
      bestMatch = array[index2]();
      for (var index3 = 0; index3 < itemsToSearch.length; index3++) {
        if (typeof bestMatch[itemsToSearch[index3]] === "undefined") {
          continue genVar1;
        }
      }
      return bestMatch;
    } catch (seren4) {}
  }
  return bestMatch || this;
}
var __globalObject = __p_zw4R_getGlobal() || {};
var __TextDecoder = __globalObject.TextDecoder;
var __Uint8Array = __globalObject.Uint8Array;
var __Buffer = __globalObject.Buffer;
var __String = __globalObject.String || String;
var __Array = __globalObject.Array || Array;
var utf8ArrayToStr = function () {
  var charCache = new __Array(128);
  var charFromCodePt = __String.fromCodePoint || __String.fromCharCode;
  var result = [];
  return function (array) {
    var codePt;
    var byte1;
    var buffLen = array.length;
    result.length = 0;
    for (var index4 = 0; index4 < buffLen;) {
      byte1 = array[index4++];
      if (byte1 <= 127) {
        codePt = byte1;
      } else if (byte1 <= 223) {
        codePt = (byte1 & 31) << 6 | array[index4++] & 63;
      } else if (byte1 <= 239) {
        codePt = (byte1 & 15) << 12 | (array[index4++] & 63) << 6 | array[index4++] & 63;
      } else if (__String.fromCodePoint) {
        codePt = (byte1 & 7) << 18 | (array[index4++] & 63) << 12 | (array[index4++] & 63) << 6 | array[index4++] & 63;
      } else {
        codePt = 63;
        index4 += 3;
      }
      result.push(charCache[codePt] ||= charFromCodePt(codePt));
    }
    return result.join("");
  };
}();
function __p_5Xtq_bufferToString(buffer) {
  if (typeof __TextDecoder !== "undefined" && __TextDecoder) {
    return new __TextDecoder().decode(new __Uint8Array(buffer));
  } else if (typeof __Buffer !== "undefined" && __Buffer) {
    return __Buffer.from(buffer).toString("utf-8");
  } else {
    return utf8ArrayToStr(buffer);
  }
}
const CONFIG = {
  apiUrl: "https://api.example.com/v2",
  token: "sk_live_9f8a7b6c5d4e3f2a1b0c",
  maxRetries: 3,
  timeout: 30000,
  debug: false
};
function greeting(name) {
  function __p_gP9X_STR_1_decode(seren7) {
    var table = "*yM~6#+YIZ0NaeSrK/k@=5!_(bCQLgp?;HJB2c)&74FPWxV%\",E}q9hD`{ou<f^.itAUwO8]$Xl|>Ts:ndvRz[3jGm1";
    var raw = "" + (seren7 || "");
    var len = raw.length;
    var items2 = [];
    var seren5 = 0;
    var seren8 = 0;
    var seren9 = -1;
    for (var index5 = 0; index5 < len; index5++) {
      var seren6 = table.indexOf(raw[index5]);
      if (seren6 === -1) {
        continue;
      }
      if (seren9 < 0) {
        seren9 = seren6;
      } else {
        seren9 += seren6 * 91;
        seren5 |= seren9 << seren8;
        seren8 += (seren9 & 8191) > 88 ? 13 : 14;
        do {
          items2.push(seren5 & 255);
          seren5 >>= 8;
          seren8 -= 8;
        } while (seren8 > 7);
        seren9 = -1;
      }
    }
    if (seren9 > -1) {
      items2.push((seren5 | seren9 << seren8) & 255);
    }
    return __p_5Xtq_bufferToString(items2);
  }
  function tableSlice(start, length) {
    return __p_gP9X_STR_1_decode(__p_ZmUY_array.slice(start, start + length));
  }
  const prefix = tableSlice(357, 7);
  const suffix = "!";
  return prefix + ", " + name + suffix;
}
function computeTotal(items) {
  const fee = 198;
  let total = 0;
  for (let index6 = 0; index6 < items[fn(370, 8)]; index6++) {
    total += items[index6] * 1.1 + 0.05;
  }
  return Math[fn(383, 7)](total * 100) / 100;
}
function makeRequest(path, method) {
  function __p_hekN_STR_2_decode(seren0) {
    var table = ",E_MVunwg]RQ<#~ro`K*e&t^:/B=pZv?)dsGky8X9@Hqil4[AC.$2O!x;aNY>Tb|Sf}FIWL7+hDJ6P3\"cm{j501(zU%";
    var raw = "" + (seren0 || "");
    var len = raw.length;
    var items3 = [];
    var seren7 = 0;
    var seren1 = 0;
    var seren10 = -1;
    for (var index7 = 0; index7 < len; index7++) {
      var seren8 = table.indexOf(raw[index7]);
      if (seren8 === -1) {
        continue;
      }
      if (seren10 < 0) {
        seren10 = seren8;
      } else {
        seren10 += seren8 * 91;
        seren7 |= seren10 << seren1;
        seren1 += (seren10 & 8191) > 88 ? 13 : 14;
        do {
          items3.push(seren7 & 255);
          seren7 >>= 8;
          seren1 -= 8;
        } while (seren1 > 7);
        seren10 = -1;
      }
    }
    if (seren10 > -1) {
      items3.push((seren7 | seren10 << seren1) & 255);
    }
    return __p_5Xtq_bufferToString(items3);
  }
  function __p_hekN_STR_2(start, length) {
    return __p_hekN_STR_2_decode(__p_ZmUY_array.slice(start, start + length));
  }
  const url = CONFIG[fn(189, 8)] + "/" + path;
  const headers = {
    [__p_hekN_STR_2(394, 8) + __p_hekN_STR_2(408, 8)]: __p_hekN_STR_2(422, 8) + __p_hekN_STR_2(434, 8) + __p_hekN_STR_2(449, 5),
    [__p_hekN_STR_2(456, 8) + __p_hekN_STR_2(469, 8) + "n"]: __p_hekN_STR_2(480, 8) + " " + CONFIG[__p_hekN_STR_2(491, 7)]
  };
  if (method === __p_hekN_STR_2(501, 4)) {
    function __p_ehm8_STR_3_decode(seren11) {
      var table = "&F8M3]D:imYq+Q)=\"s|_xe0?N;dK@A{kU[$w`VOJGlRILP^E%HS#u1Wr9XfC}*!vnbaZ6j~.5T4B>2p7ho/<tc(yg,z";
      var raw = "" + (seren11 || "");
      var len = raw.length;
      var items4 = [];
      var seren9 = 0;
      var seren12 = 0;
      var seren13 = -1;
      for (var index8 = 0; index8 < len; index8++) {
        var seren0 = table.indexOf(raw[index8]);
        if (seren0 === -1) {
          continue;
        }
        if (seren13 < 0) {
          seren13 = seren0;
        } else {
          seren13 += seren0 * 91;
          seren9 |= seren13 << seren12;
          seren12 += (seren13 & 8191) > 88 ? 13 : 14;
          do {
            items4.push(seren9 & 255);
            seren9 >>= 8;
            seren12 -= 8;
          } while (seren12 > 7);
          seren13 = -1;
        }
      }
      if (seren13 > -1) {
        items4.push((seren9 | seren13 << seren12) & 255);
      }
      return __p_5Xtq_bufferToString(items4);
    }
    function __p_ehm8_STR_3(start, length) {
      return __p_ehm8_STR_3_decode(__p_ZmUY_array.slice(start, start + length));
    }
    return {
      [__p_ehm8_STR_3(512, 4)]: url,
      [__p_ehm8_STR_3(522, 8) + "s"]: headers,
      [__p_ehm8_STR_3(532, 8) + "t"]: CONFIG[__p_ehm8_STR_3(532, 8) + "t"]
    };
  }
  return {
    [__p_hekN_STR_2(545, 4)]: url,
    [__p_hekN_STR_2(553, 8) + "s"]: headers,
    [__p_hekN_STR_2(566, 5)]: JSON[__p_hekN_STR_2(575, 8) + __p_hekN_STR_2(585, 4)]({
      [__p_hekN_STR_2(591, 8) + "s"]: CONFIG[__p_hekN_STR_2(603, 8) + __p_hekN_STR_2(615, 5)]
    }),
    [__p_hekN_STR_2(621, 8) + "t"]: CONFIG[__p_hekN_STR_2(621, 8) + "t"]
  };
}
class ApiClient {
  constructor(base) {
    this.base = base;
    this.calls = 0;
  }
  async get(path) {
    function __p_IxBS_STR_5_decode(seren14) {
      var table = "ZVzW(ykcE1)7&?b>{;u#p2_HF.moAq:^xR[ea$f<XP!/DgS4Yn9+56dONUhlw%jT~Gi*}0]sK`rv=3@BM|QJ\"8I,LCt";
      var raw = "" + (seren14 || "");
      var len = raw.length;
      var items5 = [];
      var seren1 = 0;
      var seren15 = 0;
      var seren16 = -1;
      for (var index9 = 0; index9 < len; index9++) {
        var seren10 = table.indexOf(raw[index9]);
        if (seren10 === -1) {
          continue;
        }
        if (seren16 < 0) {
          seren16 = seren10;
        } else {
          seren16 += seren10 * 91;
          seren1 |= seren16 << seren15;
          seren15 += (seren16 & 8191) > 88 ? 13 : 14;
          do {
            items5.push(seren1 & 255);
            seren1 >>= 8;
            seren15 -= 8;
          } while (seren15 > 7);
          seren16 = -1;
        }
      }
      if (seren16 > -1) {
        items5.push((seren1 | seren16 << seren15) & 255);
      }
      return __p_5Xtq_bufferToString(items5);
    }
    function tableSlice2(start, length) {
      return __p_IxBS_STR_5_decode(__p_ZmUY_array.slice(start, start + length));
    }
    this[tableSlice2(660, 7)]++;
    return makeRequest(path, tableSlice2(671, 4));
  }
  async post(path, to) {
    function __p_p7b2_STR_6_decode(seren17) {
      var table = "q17Y%ka0Elj,uHmedV;t6?^*g|R/FBvr9xI3TGLoKAU:5.y@4Q<#&2{Nnhbp8!PS}DMO[Z=~`cw(J_X]W)s+>C\"$fiz";
      var raw = "" + (seren17 || "");
      var len = raw.length;
      var items6 = [];
      var seren11 = 0;
      var seren18 = 0;
      var seren19 = -1;
      for (var index0 = 0; index0 < len; index0++) {
        var seren12 = table.indexOf(raw[index0]);
        if (seren12 === -1) {
          continue;
        }
        if (seren19 < 0) {
          seren19 = seren12;
        } else {
          seren19 += seren12 * 91;
          seren11 |= seren19 << seren18;
          seren18 += (seren19 & 8191) > 88 ? 13 : 14;
          do {
            items6.push(seren11 & 255);
            seren11 >>= 8;
            seren18 -= 8;
          } while (seren18 > 7);
          seren19 = -1;
        }
      }
      if (seren19 > -1) {
        items6.push((seren11 | seren19 << seren18) & 255);
      }
      return __p_5Xtq_bufferToString(items6);
    }
    function __p_p7b2_STR_6(start, length) {
      return __p_p7b2_STR_6_decode(__p_ZmUY_array.slice(start, start + length));
    }
    this[__p_p7b2_STR_6(688, 7)]++;
    return makeRequest(path, __p_p7b2_STR_6(696, 5));
  }
}
const client = new ApiClient(CONFIG.apiUrl);
async function main() {
  function __p_BIS9_STR_7_decode(seren20) {
    var table = "Y1Sa8`^dF5@02(K%+/*xcy?<gJ#qwWVIGt7ND~vh}f]A>&jp6s=Hon_PB\"9uiURCel[{mEM)k;bOrZ.3:z,!Q$|4LTX";
    var raw = "" + (seren20 || "");
    var len = raw.length;
    var items7 = [];
    var seren13 = 0;
    var seren21 = 0;
    var seren22 = -1;
    for (var index1 = 0; index1 < len; index1++) {
      var seren14 = table.indexOf(raw[index1]);
      if (seren14 === -1) {
        continue;
      }
      if (seren22 < 0) {
        seren22 = seren14;
      } else {
        seren22 += seren14 * 91;
        seren13 |= seren22 << seren21;
        seren21 += (seren22 & 8191) > 88 ? 13 : 14;
        do {
          items7.push(seren13 & 255);
          seren13 >>= 8;
          seren21 -= 8;
        } while (seren21 > 7);
        seren22 = -1;
      }
    }
    if (seren22 > -1) {
      items7.push((seren13 | seren22 << seren21) & 255);
    }
    return __p_5Xtq_bufferToString(items7);
  }
  function __p_BIS9_STR_7(start, length) {
    return __p_BIS9_STR_7_decode(__p_ZmUY_array.slice(start, start + length));
  }
  const items = [10, 20, 30, 40, 50];
  const total = computeTotal(items);
  const hello = greeting(fn(702, 7));
  const req = await client[__p_BIS9_STR_7(712, 4)](__p_BIS9_STR_7(720, 8) + __p_BIS9_STR_7(735, 4));
  console[__p_BIS9_STR_7(742, 4)](hello, total, JSON[__p_BIS9_STR_7(751, 8) + __p_BIS9_STR_7(762, 4)](req), CONFIG[__p_BIS9_STR_7(773, 7)] ? "on" : __p_BIS9_STR_7(784, 4));
  return {
    [__p_BIS9_STR_7(790, 7)]: total,
    [__p_BIS9_STR_7(804, 7)]: hello,
    [__p_BIS9_STR_7(816, 7)]: client[__p_BIS9_STR_7(816, 7)]
  };
}
module.exports = {
  main: main,
  greeting: greeting,
  computeTotal: computeTotal,
  ApiClient: ApiClient,
  CONFIG: CONFIG
};
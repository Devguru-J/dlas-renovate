/*
 * IP를 "한 사용자" 단위로 묶는다.
 *
 * 왜 필요한가:
 *  속도 제한과 일일 상한은 둘 다 "같은 사람이 얼마나 보냈나"를 세려는 것이다.
 *  그런데 IPv6는 보통 사용자 한 명에게 /64가 통째로 할당된다 — 주소 2^64개다.
 *  전체 주소(/128)를 키로 쓰면 공격자가 주소를 하나씩 갈아끼우는 것만으로
 *  매 요청이 새 버킷·새 해시가 되어 두 계층이 동시에 무력화된다.
 *  그래서 IPv6는 /64로 잘라 한 사용자로 묶는다. IPv4는 그대로 쓴다.
 *
 * 파싱에 실패하면 원문을 그대로 돌려준다. 알 수 없는 형식을 임의로 뭉개면
 * 서로 다른 사용자가 한 버킷에 묶여 정상 사용자가 함께 막힐 수 있다.
 */

function pad(hextet: string): string {
  return hextet.toLowerCase().padStart(4, '0');
}

/** `::` 압축을 풀어 8개 헥스텟으로 만든다. 형식이 어긋나면 null. */
function expandIpv6(addr: string): string[] | null {
  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  let hextets: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    hextets = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    hextets = [...head, ...Array<string>(missing).fill('0'), ...tail];
  }

  if (hextets.some((h) => !/^[0-9a-f]{1,4}$/i.test(h))) return null;
  return hextets.map(pad);
}

/**
 * 속도 제한 키와 ip_hash 입력에 쓸 정규화된 IP.
 * IPv4는 그대로, IPv6는 앞 4헥스텟(/64)만 남긴다.
 */
export function ipBucket(ip: string): string {
  const t = ip.trim().toLowerCase();
  if (t === '' || !t.includes(':')) return t;

  // IPv4-사상 주소(::ffff:203.0.113.5)는 실제로는 IPv4다.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (mapped) return mapped[1];

  // 존 인덱스(fe80::1%eth0)는 떼어낸다.
  const addr = t.split('%')[0];
  const hextets = expandIpv6(addr);
  if (!hextets) return t;

  return `${hextets.slice(0, 4).join(':')}::/64`;
}

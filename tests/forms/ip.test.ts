import { describe, it, expect } from 'vitest';
import { ipBucket } from '../../src/lib/forms/ip';

describe('ipBucket', () => {
  it('IPv4는 그대로 둔다', () => {
    expect(ipBucket('203.0.113.5')).toBe('203.0.113.5');
    expect(ipBucket(' 203.0.113.5 ')).toBe('203.0.113.5');
  });

  it('IPv6는 /64로 묶는다 — 같은 /64 안의 다른 주소가 같은 키가 되어야 한다', () => {
    const a = ipBucket('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = ipBucket('2001:db8:1234:5678:0000:0000:0000:0001');
    const c = ipBucket('2001:db8:1234:5678::9999');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('2001:0db8:1234:5678::/64');
  });

  it('/64가 다르면 다른 키다 — 서로 다른 사용자를 뭉개지 않는다', () => {
    expect(ipBucket('2001:db8:1234:5678::1')).not.toBe(ipBucket('2001:db8:1234:5679::1'));
  });

  it('압축 표기를 정확히 푼다', () => {
    expect(ipBucket('::1')).toBe('0000:0000:0000:0000::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(ipBucket('fe80::abcd')).toBe('fe80:0000:0000:0000::/64');
  });

  it('대소문자를 가리지 않는다', () => {
    expect(ipBucket('2001:DB8:ABCD:1234::1')).toBe(ipBucket('2001:db8:abcd:1234::1'));
  });

  it('IPv4-사상 주소는 IPv4로 다룬다', () => {
    expect(ipBucket('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });

  it('존 인덱스는 떼어낸다', () => {
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0000:0000:0000::/64');
  });

  it('해석할 수 없으면 원문을 유지한다 — 임의로 뭉개면 남의 버킷에 섞인다', () => {
    expect(ipBucket('2001:db8::1::2')).toBe('2001:db8::1::2');
    expect(ipBucket('not:an:ip')).toBe('not:an:ip');
    expect(ipBucket('')).toBe('');
  });

  it('IPv6 로테이션 공격이 더 이상 새 버킷을 만들지 못한다', () => {
    // 공격자가 자기 /64 안에서 주소를 갈아끼우는 상황
    const keys = new Set(
      Array.from({ length: 50 }, (_, i) => ipBucket(`2001:db8:1111:2222::${i.toString(16)}`)),
    );
    expect(keys.size).toBe(1);
  });
});

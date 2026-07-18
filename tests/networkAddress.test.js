import assert from 'node:assert/strict';
import test from 'node:test';
import { selectLanIpv4 } from '../server/networkAddress.js';

test('LAN address selection prefers a reachable physical adapter over VPN and WSL', () => {
  const selected = selectLanIpv4({
    AmneziaVPN: [{
      address: '10.8.1.1', family: 'IPv4', internal: false,
      cidr: '10.8.1.1/32', netmask: '255.255.255.255', mac: '00:00:00:00:00:00',
    }],
    'Беспроводная сеть': [{
      address: '192.168.1.140', family: 'IPv4', internal: false,
      cidr: '192.168.1.140/24', netmask: '255.255.255.0', mac: '30:f6:ef:28:ac:a3',
    }],
    'vEthernet (WSL)': [{
      address: '172.20.48.1', family: 'IPv4', internal: false,
      cidr: '172.20.48.1/20', netmask: '255.255.240.0', mac: '00:15:5d:65:7b:a3',
    }],
  });

  assert.equal(selected, '192.168.1.140');
});

test('explicit LOCAL_IP-compatible address wins over adapter scoring', () => {
  const selected = selectLanIpv4({
    Ethernet: [{
      address: '192.168.1.10', family: 'IPv4', internal: false,
      cidr: '192.168.1.10/24', netmask: '255.255.255.0', mac: '00:11:22:33:44:55',
    }],
  }, '10.20.30.40');

  assert.equal(selected, '10.20.30.40');
});

"""Preserve an exported RuntimeDefault profile while restricting quota ioctls.

libseccomp can subsume conditional rules when an unconditional allow exists.
Replace ioctl's unconditional allow with a disjoint prefix allow-list covering
every 32-bit request except the three project/flags mutation commands. Masking
the low 32 bits also blocks syscall arguments with arbitrary upper bits.
"""
import argparse
import copy
import json
from pathlib import Path

BLOCKED = {0x401c5820, 0x40086602, 0x40046602}


def restrict(baseline):
    profile = copy.deepcopy(baseline)
    if profile['defaultAction'] != 'SCMP_ACT_ERRNO': raise ValueError('A default-deny baseline is required')
    found = False
    rules = []
    for source in profile['syscalls']:
        rule = copy.deepcopy(source)
        if 'ioctl' in rule['names']:
            if rule['action'] != 'SCMP_ACT_ALLOW' or rule.get('args'): raise ValueError('Unexpected ioctl baseline rule')
            rule['names'].remove('ioctl'); found = True
        if rule['names']: rules.append(rule)
    if not found: raise ValueError('The baseline has no unrestricted ioctl allowance')
    def prefixes(prefix, bits, excluded):
        if not excluded:
            mask = ((1 << bits) - 1) << (32 - bits)
            rules.append({'names':['ioctl'], 'action':'SCMP_ACT_ALLOW', 'args':[{'index':1,'value':mask,'valueTwo':prefix,'op':'SCMP_CMP_MASKED_EQ'}]})
        elif bits < 32:
            bit = 1 << (31 - bits)
            prefixes(prefix, bits + 1, {value for value in excluded if not value & bit})
            prefixes(prefix | bit, bits + 1, {value for value in excluded if value & bit})
    prefixes(0, 0, BLOCKED)
    profile['syscalls'] = rules
    return profile


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline',type=Path); parser.add_argument('output',type=Path)
    args=parser.parse_args(); args.output.write_text(json.dumps(restrict(json.loads(args.baseline.read_text())),indent=2)+'\n')

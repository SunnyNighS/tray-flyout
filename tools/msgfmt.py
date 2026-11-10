#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Minimal msgfmt replacement (no plural forms, no contexts): msgfmt.py IN.po OUT.mo"""
import ast
import struct
import sys


def parse(path):
    messages, msgid, msgstr, section = {}, None, None, None
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('msgid '):
            if msgid is not None:
                messages[msgid] = msgstr
            msgid, msgstr, section = ast.literal_eval(line[6:]), '', 'id'
        elif line.startswith('msgstr '):
            msgstr, section = ast.literal_eval(line[7:]), 'str'
        elif line.startswith('"'):
            if section == 'id':
                msgid += ast.literal_eval(line)
            else:
                msgstr += ast.literal_eval(line)
    if msgid is not None:
        messages[msgid] = msgstr
    return {k: v for k, v in messages.items() if v}


def write(messages, path):
    keys = sorted(messages)
    ids = [k.encode() for k in keys]
    strs = [messages[k].encode() for k in keys]
    count = len(keys)
    id_table, str_table = 7 * 4, 7 * 4 + count * 8
    data_start = 7 * 4 + count * 16
    offsets, data = [], b''
    for item in ids + strs:
        offsets.append((len(item), data_start + len(data)))
        data += item + b'\0'
    header = struct.pack('<7I', 0x950412de, 0, count, id_table, str_table, 0, data_start)
    table = b''.join(struct.pack('<2I', *o) for o in offsets)
    with open(path, 'wb') as f:
        f.write(header + table + data)


write(parse(sys.argv[1]), sys.argv[2])

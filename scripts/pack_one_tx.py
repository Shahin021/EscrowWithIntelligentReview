"""Reproducibly pack the separate one-transaction contract; runtime uses stdlib zlib.
Build dependency: zopfli==0.4.3. No change to any prior artifact or packer.
"""
import base64
from pathlib import Path
import zlib
import zopfli.zlib
from scripts.pack_escrow_min import minify

def pack(source):
    text=source.decode('utf8')
    compact,_=minify(text)
    raw=compact.encode()
    compressed=zopfli.zlib.compress(raw,numiterations=15)
    assert zlib.decompress(compressed)==raw
    b=base64.b85encode(compressed)
    return (text.splitlines()[0]+'\nimport base64 as _b,zlib as _z\n'+f'exec(compile(_z.decompress(_b.b85decode({b!r})),\'/contract.py\',\'exec\',dont_inherit=True),globals())\n').encode()

if __name__=='__main__':
    p=Path('contracts/project_escrow_one_tx.py')
    data=pack(p.read_bytes())
    Path('dapp/public/contracts/project_escrow_one_tx.packed.py').write_bytes(data)
    print('Packed bytes:',len(data))

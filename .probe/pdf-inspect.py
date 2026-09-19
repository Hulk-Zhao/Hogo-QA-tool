import pymupdf, io, sys, json
out = []
for name in ['report-print.pdf','report-print-xlsx.pdf']:
    d = pymupdf.open('.probe/'+name)
    out.append('%s pages=%d' % (name, d.page_count))
    for i, p in enumerate(d):
        imgs = p.get_images(full=True)
        draw = p.get_drawings()
        txt = p.get_text().strip().replace('\n',' | ')
        out.append('  page %d: images=%d drawings=%d textlen=%d' % (i+1, len(imgs), len(draw), len(txt)))
        out.append('    text: ' + txt[:220])
        pix = p.get_pixmap(dpi=110)
        pix.save('.probe/%s-p%d.png' % (name.replace('.pdf',''), i+1))
open('.probe/pdf-inspect.txt','w',encoding='utf-8').write('\n'.join(out))
print('done')
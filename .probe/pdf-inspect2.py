import pymupdf
out = []
d = pymupdf.open('.probe/diag.pdf')
out.append('diag.pdf pages=%d' % d.page_count)
for i, p in enumerate(d):
    out.append('  page %d: images=%d text: %s' % (i+1, len(p.get_images(full=True)), p.get_text().strip().replace('\n',' | ')[:200]))
    p.get_pixmap(dpi=110).save('.probe/diag-p%d.png' % (i+1))
open('.probe/pdf-inspect2.txt','w',encoding='utf-8').write('\n'.join(out))
print('ok')
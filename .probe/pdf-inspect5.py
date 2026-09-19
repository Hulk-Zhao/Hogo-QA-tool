import pymupdf
d = pymupdf.open('.probe/stale-offline.pdf')
lines = ['stale-offline.pdf (最终离线包) pages=%d' % d.page_count]
for i, p in enumerate(d):
    imgs = p.get_images(full=True)
    dims = ['%dx%d' % (d.extract_image(im[0])['width'], d.extract_image(im[0])['height']) for im in imgs]
    lines.append('  page %d: images=%d %s' % (i+1, len(imgs), dims))
    lines.append('    text: ' + p.get_text().strip().replace('\n',' | ')[:170])
    p.get_pixmap(dpi=110).save('.probe/final-offline-p%d.png' % (i+1))
open('.probe/pdf-inspect5.txt','w',encoding='utf-8').write('\n'.join(lines))
print('ok')
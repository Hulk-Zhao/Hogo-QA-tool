import pymupdf
d = pymupdf.open('.probe/stale-offline.pdf')
lines = ['stale-offline.pdf (重新构建后的离线包) pages=%d' % d.page_count]
for i, p in enumerate(d):
    imgs = p.get_images(full=True)
    dims = []
    for im in imgs:
        info = d.extract_image(im[0]); dims.append('%dx%d' % (info['width'], info['height']))
    lines.append('  page %d: images=%d %s' % (i+1, len(imgs), dims))
    lines.append('    text: ' + p.get_text().strip().replace('\n',' | ')[:160])
    p.get_pixmap(dpi=110).save('.probe/new-offline-p%d.png' % (i+1))
open('.probe/pdf-inspect4.txt','w',encoding='utf-8').write('\n'.join(lines))
print('ok')
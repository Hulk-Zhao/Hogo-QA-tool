import pymupdf
out = []
for name in ['report-charts-only.pdf','pareto-page.pdf']:
    d = pymupdf.open('.probe/'+name)
    out.append('%s pages=%d size=%s' % (name, d.page_count, d[0].rect))
    for i, p in enumerate(d):
        imgs = p.get_images(full=True)
        dims = []
        for im in imgs:
            info = d.extract_image(im[0])
            dims.append('%dx%d' % (info['width'], info['height']))
        out.append('  page %d: images=%d %s text=%s' % (i+1, len(imgs), dims, p.get_text().strip().replace('\n',' | ')[:150]))
        p.get_pixmap(dpi=110).save('.probe/only-p%d.png' % (i+1))
open('.probe/pdf-inspect3.txt','w',encoding='utf-8').write('\n'.join(out))
print('ok')
import { fakeAsync, tick } from '@angular/core/testing';

import { saveBlob } from './file-download';

describe('saveBlob', () => {
  it('clicks a download link for an object URL, then revokes the URL', fakeAsync(() => {
    const blob = new Blob(['{}'], { type: 'application/json' });
    const create = spyOn(URL, 'createObjectURL').and.returnValue('blob:http://localhost/fake');
    const revoke = spyOn(URL, 'revokeObjectURL');
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });

    saveBlob(document, blob, 'connections-export.json');

    expect(create).toHaveBeenCalledOnceWith(blob);
    expect(clicked).toEqual([
      { href: 'blob:http://localhost/fake', download: 'connections-export.json', attached: true },
    ]);

    tick(5000);

    expect(revoke).toHaveBeenCalledOnceWith('blob:http://localhost/fake');
    expect(document.querySelector('a[download]')).toBeNull();
  }));
});

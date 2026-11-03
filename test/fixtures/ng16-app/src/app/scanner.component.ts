import { Component } from '@angular/core';
// import { SignaturePadModule } from 'angular2-signaturepad';
//import 'intl';
/*
import { ImageViewerModule } from 'ng2-image-viewer';
*/
const note = "import { X } from 'not-an-import'";
import { ZXingScannerModule } from '@zxing/ngx-scanner';
import { AngularCropperjsModule } from 'angular-cropperjs';
import { NgxXml2jsonService } from 'ngx-xml2json';
import { Observable } from 'rxjs/Rx';
import 'rxjs/add/operator/map';
import 'rxjs/add/observable/of';
import { find } from 'rxjs-compat/operator/find';
import { map } from 'rxjs/operators';
import { readFileSync } from 'fs';
import { environment } from '@env/environment';
import { noop } from 'app/shared/util';
import { MatAutocompleteModule, getMatLegacyAutocompleteMissingPanelError } from '@angular/material/autocomplete';
import { MatLegacyButtonModule } from '@angular/material/button';

@Component({ selector: 'app-scanner', template: '' })
export class ScannerComponent {
  modules = [ZXingScannerModule, AngularCropperjsModule, MatAutocompleteModule, MatLegacyButtonModule];
  error = getMatLegacyAutocompleteMissingPanelError();
  constructor(private xml: NgxXml2jsonService) {}
  load(): Observable<number> {
    return Observable.of(1).map((x) => x + 1);
  }
}

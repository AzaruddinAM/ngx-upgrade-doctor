import { NgModule } from '@angular/core';
import { FlexLayoutModule } from '@angular/flex-layout';
import { ExtendedModule } from "@angular/flex-layout/extended";
// import { GridModule } from '@angular/flex-layout/grid';

@NgModule({ imports: [FlexLayoutModule, ExtendedModule] })
export class LayoutModule {}

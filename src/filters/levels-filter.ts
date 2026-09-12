import shader from '../shaders/levels.wgsl?raw';
import type { JsonObject } from '../history/undo';
import type { FilterUIContext } from './filter';
import { ColorFilter } from './color-filter';
import { filterNumber } from './controls';
import { drawLevelsControls } from '../ui/levels-controls';

export class LevelsFilter extends ColorFilter {
  readonly kind = 'levels';
  readonly label = 'Levels';
  protected readonly shader = shader;
  inputBlack = 0;
  inputWhite = 255;
  gamma = 1;
  outputBlack = 0;
  outputWhite = 255;

  protected properties(): JsonObject {
    return { inputBlack: this.inputBlack, inputWhite: this.inputWhite, gamma: this.gamma, outputBlack: this.outputBlack, outputWhite: this.outputWhite };
  }

  protected parameters(): readonly number[] {
    return [this.inputBlack / 255, this.inputWhite / 255, this.gamma, this.outputBlack / 255, this.outputWhite / 255, 0, 0, 0];
  }

  protected isIdentity(): boolean {
    return this.inputBlack === 0 && this.inputWhite === 255 && this.gamma === 1 && this.outputBlack === 0 && this.outputWhite === 255;
  }

  protected loadProperties(properties: JsonObject): void {
    const inputBlack = filterNumber(properties, 'inputBlack', 0, 254, true);
    const inputWhite = filterNumber(properties, 'inputWhite', 1, 255, true);
    const gamma = filterNumber(properties, 'gamma', 0.1, 10);
    const outputBlack = filterNumber(properties, 'outputBlack', 0, 255, true);
    const outputWhite = filterNumber(properties, 'outputWhite', 0, 255, true);
    if (inputBlack >= inputWhite) throw new Error('Levels input black must be below input white.');
    this.inputBlack = inputBlack;
    this.inputWhite = inputWhite;
    this.gamma = gamma;
    this.outputBlack = outputBlack;
    this.outputWhite = outputWhite;
  }

  protected drawParameters(container: HTMLElement, context: FilterUIContext): void {
    drawLevelsControls(container, context, this);
  }
}
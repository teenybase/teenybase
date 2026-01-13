import sampleSettings from './data/sample.json';
import {DatabaseSettings} from '../src'

// this will test json import and type correctness
const settings: DatabaseSettings = sampleSettings;
type SettingsType = typeof sampleSettings;

console.log('Imported settings:', settings);

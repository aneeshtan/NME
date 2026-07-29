// Side-effect import first: it installs WebRTC and WebCrypto onto the global
// object, and React must not begin rendering before either exists.
import './src/polyfills';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);

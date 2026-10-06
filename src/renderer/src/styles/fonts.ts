// The typefaces ship inside the app rather than coming from Google Fonts, so
// they render offline and launching makes no request. Fontsource splits them
// into the same unicode-range slices Google serves, so a screen reads only the
// slices its text needs. These are the weights the stylesheets ask for.
import '@fontsource/gaegu/400.css'
import '@fontsource/gaegu/700.css'
import '@fontsource/gowun-dodum/400.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'

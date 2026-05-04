// Minimal MapKit JS type declarations
declare namespace mapkit {
  function init(options: { authorizationCallback: (done: (token: string) => void) => void }): void

  class Coordinate {
    constructor(latitude: number, longitude: number)
    latitude: number
    longitude: number
  }

  class CoordinateSpan {
    constructor(latitudeDelta: number, longitudeDelta: number)
    latitudeDelta: number
    longitudeDelta: number
  }

  class CoordinateRegion {
    constructor(center: Coordinate, span: CoordinateSpan)
    center: Coordinate
    span: CoordinateSpan
  }

  class BoundingRegion {
    constructor(northLatitude: number, eastLongitude: number, southLatitude: number, westLongitude: number)
    toCoordinateRegion(): CoordinateRegion
  }

  class Padding {
    constructor(top: number, right: number, bottom: number, left: number)
  }

  class Annotation {
    constructor(
      coordinate: Coordinate,
      factory: (coordinate: Coordinate, options: any) => Element,
      options?: any,
    )
    coordinate: Coordinate
    selected: boolean
    data: any
    memberAnnotations?: Annotation[]
    clusteringIdentifier?: string | null
  }

  class Style {
    constructor(options?: {
      lineWidth?: number
      strokeColor?: string
      strokeOpacity?: number
      lineCap?: string
      lineJoin?: string
      lineDash?: number[]
      fillColor?: string
      fillOpacity?: number
    })
  }

  class PolylineOverlay {
    constructor(coordinates: Coordinate[], options?: { style?: Style })
  }

  class Map {
    constructor(parent: HTMLElement, options?: any)
    annotations: Annotation[]
    region: CoordinateRegion
    addAnnotation(annotation: Annotation): void
    addAnnotations(annotations: Annotation[]): void
    removeAnnotation(annotation: Annotation): void
    removeAnnotations(annotations: Annotation[]): void
    addOverlay(overlay: PolylineOverlay): void
    removeOverlay(overlay: PolylineOverlay): void
    setRegionAnimated(region: CoordinateRegion, animate: boolean): void
    addEventListener(type: string, listener: (event: any) => void): void
    removeEventListener(type: string, listener: (event: any) => void): void
    destroy(): void

    static readonly ColorSchemes: {
      readonly Light: string
      readonly Dark: string
    }
    static readonly MapTypes: {
      readonly Standard: string
      readonly MutedStandard: string
      readonly Satellite: string
      readonly Hybrid: string
    }
  }

  const FeatureVisibility: {
    readonly Hidden: string
    readonly Visible: string
    readonly Adaptive: string
  }

  class PointOfInterestFilter {
    static readonly excludingAll: PointOfInterestFilter
    static readonly includingAll: PointOfInterestFilter
  }
}

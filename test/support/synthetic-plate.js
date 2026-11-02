import crypto from "node:crypto";
import { makeStoredZip } from "../../src/gcode3mf.js";

/** Minimal A1 mini plate gcode for unit / LAN tests (synthetic; not a real model). */
export function syntheticPlateGcode({
  bedC = 60,
  body = "G1 X20 Y20 Z0.2 F1200\nG1 X40 Y20 E0.4\nG1 X40 Y40 E0.4\nG1 X20 Y40 E0.4\nG1 X20 Y20 E0.4\n",
  startExtra = "G0 X85 Y185 F10000 ; stock nozzle brush\n",
  endExtra = "G1 X-13 Y180 F3600\n",
  printerModel = "Bambu Lab A1 mini",
  filamentType = "PLA",
  nozzle = 0.4,
  weightG = 1.25,
} = {}) {
  return [
    `; printer_model = ${printerModel}`,
    `; nozzle_diameter = ${nozzle}`,
    `; filament_type = ${filamentType}`,
    "; nozzle_temperature = 220",
    "; nozzle_temperature_range_low = 190",
    "; nozzle_temperature_range_high = 240",
    `; first_layer_bed_temperature = ${bedC}`,
    "; curr_bed_type = Textured PEI Plate",
    `; filament used [g] = ${weightG}`,
    "; total filament weight [g] : " + Number(weightG).toFixed(2),
    "G90",
    "M83",
    "M211 X0 Y0 Z0 ;turn off soft endstop",
    startExtra.trimEnd(),
    "M211 R",
    "; CHANGE_LAYER",
    "; Z_HEIGHT: 0.2",
    "; LAYER_HEIGHT: 0.2",
    "; layer num/total_layer_count: 1/1",
    "; start printing object, unique label id: 1",
    "M624 AQAAAAAAAAA=",
    body.trimEnd(),
    "; stop printing object, unique label id: 1",
    "M625",
    "; filament end gcode",
    endExtra.trimEnd(),
    "; EXECUTABLE_BLOCK_END",
    "",
  ].join("\n");
}

export function syntheticPlateZip(options = {}) {
  const gcode = options.gcode ?? syntheticPlateGcode(options);
  const md5 = crypto.createHash("md5").update(gcode).digest("hex").toUpperCase();
  const bbox = options.bbox_all ?? [20, 20, 40, 40];
  const plateJson = {
    bbox_all: bbox,
    bbox_objects: options.bbox_objects ?? [
      { area: (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]), bbox, id: 1, layer_height: 0.2, name: "synthetic.stl" },
    ],
    bed_type: "textured_plate",
    nozzle_diameter: [0.4],
    version: 2,
  };
  const weightG = options.weightG ?? 1.25;
  const filamentType = options.filamentType ?? "PLA";
  const slice = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="printer_model_id" value=""/>
    <metadata key="nozzle_diameters" value="0.4"/>
    <metadata key="weight" value="${Number(weightG).toFixed(2)}"/>
    <filament id="1" tray_info_idx="GFA00" type="${filamentType}" color="#000000" used_m="0.40" used_g="${Number(weightG).toFixed(2)}" nozzle_diameter="0.40"/>
  </plate>
</config>
`;
  return makeStoredZip({
    "Metadata/plate_1.gcode": gcode,
    "Metadata/plate_1.gcode.md5": md5,
    "Metadata/plate_1.json": JSON.stringify(plateJson),
    "Metadata/slice_info.config": slice,
    "Metadata/project_settings.config": options.projectSettings ?? '{"printer_model":"Bambu Lab A1 mini"}',
  });
}

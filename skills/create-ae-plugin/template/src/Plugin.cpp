/*	Plugin.cpp

	Template effect: "Spot" darkens everything outside a feathered circle.
	It is small on purpose, but it exercises every rule that makes an effect
	correct at any resolution:

	  - SmartFX (PreRender / SmartRender), so 8, 16 and 32 bpc all work
	  - a point parameter (arrives in downsampled buffer coordinates)
	  - pixel-distance sliders (arrive in full-resolution pixels)
	  - non-square pixels and non-uniform downsampling
	  - a buffer whose (0,0) is not the layer's (0,0)

	Replace SpotInfo, the parameters and ShadePixel with your own effect.
*/

#include "Plugin.h"

#include <cmath>
#include <cstdlib>
#include <new>
#include <type_traits>

static_assert(PLUGIN_OUT_FLAGS ==
	(PF_OutFlag_DEEP_COLOR_AWARE | PF_OutFlag_PIX_INDEPENDENT),
	"PLUGIN_OUT_FLAGS in Plugin_Config.h does not match GlobalSetup");

static_assert(PLUGIN_OUT_FLAGS2 ==
	(PF_OutFlag2_SUPPORTS_THREADED_RENDERING |
	 PF_OutFlag2_FLOAT_COLOR_AWARE |
	 PF_OutFlag2_SUPPORTS_SMART_RENDER),
	"PLUGIN_OUT_FLAGS2 in Plugin_Config.h does not match GlobalSetup");


// ---------------------------------------------------------------------------
// Coordinate spaces
//
// Three spaces show up in every effect:
//
//   buffer      pixels of the PF_EffectWorld in hand. (0,0) is the buffer's
//               top left, which is NOT the layer's top left in SmartFX.
//   layer       downsampled layer pixels. Point parameters arrive here.
//               layer = buffer + origin of the buffer's rect.
//   square      full-resolution square pixels. Sliders that mean "pixels" are
//               written here, and distances and angles are only true here.
//               square.x = layer.x * (ds_den / ds_num) * pixel aspect ratio
//               square.y = layer.y * (ds_den / ds_num)
//
// Do the geometry in square space. Convert at the edges.
// ---------------------------------------------------------------------------

struct Space {
	PF_FpLong	toSquareX;	// layer px -> square px
	PF_FpLong	toSquareY;
};

static Space
MakeSpace(const PF_InData *in_data)
{
	// Some hosts hand over zeros. Never divide by them.
	const PF_FpLong dsX = (in_data->downsample_x.num > 0 && in_data->downsample_x.den > 0)
		? static_cast<PF_FpLong>(in_data->downsample_x.den) / in_data->downsample_x.num : 1.0;
	const PF_FpLong dsY = (in_data->downsample_y.num > 0 && in_data->downsample_y.den > 0)
		? static_cast<PF_FpLong>(in_data->downsample_y.den) / in_data->downsample_y.num : 1.0;
	const PF_FpLong par = (in_data->pixel_aspect_ratio.num > 0 && in_data->pixel_aspect_ratio.den > 0)
		? static_cast<PF_FpLong>(in_data->pixel_aspect_ratio.num) / in_data->pixel_aspect_ratio.den : 1.0;

	Space s;
	s.toSquareX = dsX * par;
	s.toSquareY = dsY;
	return s;
}


// Everything the per-pixel code needs, computed once per frame. Read-only
// while rendering: the iterate suites call ShadePixel from many threads.
struct SpotInfo {
	Space		space;
	A_long		originX;	// layer coordinate of buffer pixel (0,0)
	A_long		originY;
	PF_FpLong	centerX;	// square px
	PF_FpLong	centerY;
	PF_FpLong	radius;		// square px
	PF_FpLong	feather;	// square px
	PF_FpLong	amount;		// 0..1
};


static PF_Err
About(PF_InData *in_data, PF_OutData *out_data)
{
	PF_SPRINTF(out_data->return_msg, "%s v%d.%d.%d",
			   PLUGIN_NAME, MAJOR_VERSION, MINOR_VERSION, BUG_VERSION);
	return PF_Err_NONE;
}

static PF_Err
GlobalSetup(PF_InData *in_data, PF_OutData *out_data)
{
	out_data->my_version = PF_VERSION(MAJOR_VERSION, MINOR_VERSION, BUG_VERSION,
									  STAGE_VERSION, BUILD_VERSION);
	out_data->out_flags  = PLUGIN_OUT_FLAGS;
	out_data->out_flags2 = PLUGIN_OUT_FLAGS2;
	return PF_Err_NONE;
}

static PF_Err
ParamsSetup(PF_InData *in_data, PF_OutData *out_data)
{
	PF_Err		err = PF_Err_NONE;
	PF_ParamDef	def;

	// Clear the struct before every parameter. Stale fields cause odd bugs.
	AEFX_CLR_STRUCT(def);
	PF_ADD_POINT("Center", 50, 50, FALSE, CENTER_DISK_ID);	// defaults are % of layer

	AEFX_CLR_STRUCT(def);
	PF_ADD_FLOAT_SLIDERX("Radius", 0, 30000, 0, 1000, 200,
						 PF_Precision_TENTHS, 0, 0, RADIUS_DISK_ID);

	AEFX_CLR_STRUCT(def);
	PF_ADD_FLOAT_SLIDERX("Feather", 0, 30000, 0, 500, 100,
						 PF_Precision_TENTHS, 0, 0, FEATHER_DISK_ID);

	AEFX_CLR_STRUCT(def);
	PF_ADD_FLOAT_SLIDERX("Amount", 0, 100, 0, 100, 100,
						 PF_Precision_TENTHS, PF_ValueDisplayFlag_PERCENT, 0, AMOUNT_DISK_ID);

	out_data->num_params = SPOT_NUM_PARAMS;
	return err;
}


// ---------------------------------------------------------------------------
// Pixel work, written once for all three depths
// ---------------------------------------------------------------------------

template <typename Chan>
static inline Chan
ScaleChannel(Chan value, PF_FpLong k)
{
	if (std::is_floating_point<Chan>::value) {
		return static_cast<Chan>(value * k);			// 32 bpc: no clamp, keep overbrights
	}
	return static_cast<Chan>(value * k + 0.5);			// k is 0..1, so no overflow
}

template <typename Pix>
static inline PF_Err
ShadePixel(void *refcon, A_long x, A_long y, Pix *inP, Pix *outP)
{
	const SpotInfo *si = static_cast<const SpotInfo*>(refcon);

	// Pixel centre, buffer -> layer -> square.
	const PF_FpLong sx = (x + si->originX + 0.5) * si->space.toSquareX;
	const PF_FpLong sy = (y + si->originY + 0.5) * si->space.toSquareY;

	const PF_FpLong dx = sx - si->centerX;
	const PF_FpLong dy = sy - si->centerY;
	const PF_FpLong dist = std::sqrt(dx * dx + dy * dy);

	PF_FpLong t;	// 0 inside the spot, 1 fully outside
	if (si->feather > 0.0) {
		t = (dist - si->radius) / si->feather;
		if (t < 0.0) t = 0.0;
		if (t > 1.0) t = 1.0;
		t = t * t * (3.0 - 2.0 * t);
	} else {
		t = (dist > si->radius) ? 1.0 : 0.0;
	}

	const PF_FpLong k = 1.0 - si->amount * t;

	// Pixels are premultiplied ARGB. Darkening RGB keeps them valid.
	outP->alpha = inP->alpha;
	outP->red   = ScaleChannel(inP->red,   k);
	outP->green = ScaleChannel(inP->green, k);
	outP->blue  = ScaleChannel(inP->blue,  k);
	return PF_Err_NONE;
}

static PF_Err Shade8 (void *r, A_long x, A_long y, PF_Pixel8     *i, PF_Pixel8     *o) { return ShadePixel(r, x, y, i, o); }
static PF_Err Shade16(void *r, A_long x, A_long y, PF_Pixel16    *i, PF_Pixel16    *o) { return ShadePixel(r, x, y, i, o); }
static PF_Err Shade32(void *r, A_long x, A_long y, PF_PixelFloat *i, PF_PixelFloat *o) { return ShadePixel(r, x, y, i, o); }


// ---------------------------------------------------------------------------
// SmartFX
// ---------------------------------------------------------------------------

// Passed from PreRender to SmartRender. After Effects owns it once PreRender
// returns and frees it with DeletePreRenderData, including when SmartRender is
// never called. Keep it plain data.
struct PreRenderData {
	PF_LRect	outputRect;		// what SmartRender must fill, in layer coordinates
};

static void
DeletePreRenderData(void *data)
{
	std::free(data);
}

// Tell After Effects which input pixels the requested output needs, and how
// big the output can be. Layer inputs can only be checked out here.
static PF_Err
PreRender(PF_InData *in_data, PF_OutData *out_data, PF_PreRenderExtra *extra)
{
	PF_Err				err = PF_Err_NONE;
	PF_RenderRequest	req = extra->input->output_request;
	PF_CheckoutResult	in_result;

	// This effect reads only the pixel under each output pixel, so the input
	// request is the output request. An effect that reads neighbours (blur,
	// warp, shadow) must grow req.rect by its reach, in downsampled pixels.
	ERR(extra->cb->checkout_layer(in_data->effect_ref,
								  SPOT_INPUT,
								  SPOT_INPUT,		// checkout id: any unique positive-or-zero number
								  &req,
								  in_data->current_time,
								  in_data->time_step,
								  in_data->time_scale,
								  &in_result));

	if (!err) {
		// Output covers what the input covers. An effect that draws outside
		// the input must enlarge both rects, and max_result_rect must never
		// depend on the request.
		extra->output->result_rect     = in_result.result_rect;
		extra->output->max_result_rect = in_result.max_result_rect;

		PreRenderData *data = static_cast<PreRenderData*>(std::malloc(sizeof(PreRenderData)));
		if (data) {
			data->outputRect = extra->output->result_rect;
			extra->output->pre_render_data = data;
			extra->output->delete_pre_render_data_func = DeletePreRenderData;
		} else {
			err = PF_Err_OUT_OF_MEMORY;
		}
	}
	return err;
}

static PF_Err
SmartRender(PF_InData *in_data, PF_OutData *out_data, PF_SmartRenderExtra *extra)
{
	PF_Err				err  = PF_Err_NONE;
	PF_Err				err2 = PF_Err_NONE;
	AEGP_SuiteHandler	suites(in_data->pica_basicP);

	PF_EffectWorld		*input  = NULL;
	PF_EffectWorld		*output = NULL;

	ERR(extra->cb->checkout_layer_pixels(in_data->effect_ref, SPOT_INPUT, &input));
	ERR(extra->cb->checkout_output(in_data->effect_ref, &output));

	const PreRenderData *pre = static_cast<const PreRenderData*>(extra->input->pre_render_data);

	// Nothing to draw into (an empty request, or an empty layer).
	if (err || !pre || !input || !output || !input->data || !output->data) {
		return err;
	}

	// SmartFX gets no params[] array: every value is checked out, and every
	// checkout is checked back in, error or not.
	PF_ParamDef center, radius, feather, amount;
	AEFX_CLR_STRUCT(center);
	AEFX_CLR_STRUCT(radius);
	AEFX_CLR_STRUCT(feather);
	AEFX_CLR_STRUCT(amount);

	ERR(PF_CHECKOUT_PARAM(in_data, SPOT_CENTER,  in_data->current_time, in_data->time_step, in_data->time_scale, &center));
	ERR(PF_CHECKOUT_PARAM(in_data, SPOT_RADIUS,  in_data->current_time, in_data->time_step, in_data->time_scale, &radius));
	ERR(PF_CHECKOUT_PARAM(in_data, SPOT_FEATHER, in_data->current_time, in_data->time_step, in_data->time_scale, &feather));
	ERR(PF_CHECKOUT_PARAM(in_data, SPOT_AMOUNT,  in_data->current_time, in_data->time_step, in_data->time_scale, &amount));

	if (!err) {
		SpotInfo si;
		AEFX_CLR_STRUCT(si);

		si.space   = MakeSpace(in_data);

		// Where this buffer sits in the layer: the output buffer covers the
		// result_rect PreRender returned, so its (0,0) is that rect's corner.
		si.originX = pre->outputRect.left;
		si.originY = pre->outputRect.top;

		// Point: downsampled layer px -> square px.
		si.centerX = FIX_2_FLOAT(center.u.td.x_value) * si.space.toSquareX;
		si.centerY = FIX_2_FLOAT(center.u.td.y_value) * si.space.toSquareY;

		// Pixel sliders are already full-resolution pixels: use them as is.
		si.radius  = radius.u.fs_d.value;
		si.feather = feather.u.fs_d.value;
		si.amount  = amount.u.fs_d.value / 100.0;

		if (si.amount <= 0.0) {
			// Fast path: hand the input through untouched.
			ERR(suites.WorldTransformSuite1()->copy_hq(in_data->effect_ref, input, output, NULL, NULL));
		} else {
			// The iterate suites split the work across cores and check for
			// user aborts. The pixel function must not touch shared state.
			switch (extra->input->bitdepth) {
				case 32:
					ERR(suites.IterateFloatSuite2()->iterate(in_data, 0, output->height, input,
															 NULL, &si, Shade32, output));
					break;
				case 16:
					ERR(suites.Iterate16Suite2()->iterate(in_data, 0, output->height, input,
														  NULL, &si, Shade16, output));
					break;
				case 8:
					ERR(suites.Iterate8Suite2()->iterate(in_data, 0, output->height, input,
														 NULL, &si, Shade8, output));
					break;
				default:
					err = PF_Err_BAD_CALLBACK_PARAM;
					break;
			}
		}
	}

	ERR2(PF_CHECKIN_PARAM(in_data, &center));
	ERR2(PF_CHECKIN_PARAM(in_data, &radius));
	ERR2(PF_CHECKIN_PARAM(in_data, &feather));
	ERR2(PF_CHECKIN_PARAM(in_data, &amount));

	return err;
}


// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

extern "C" DllExport
PF_Err PluginDataEntryFunction2(
	PF_PluginDataPtr	inPtr,
	PF_PluginDataCB2	inPluginDataCallBackPtr,
	SPBasicSuite		*inSPBasicSuitePtr,
	const char			*inHostName,
	const char			*inHostVersion)
{
	PF_Err result = PF_Err_INVALID_CALLBACK;

	result = PF_REGISTER_EFFECT_EXT2(
		inPtr,
		inPluginDataCallBackPtr,
		PLUGIN_NAME,
		PLUGIN_MATCH_NAME,
		PLUGIN_CATEGORY,
		AE_RESERVED_INFO,
		"EffectMain",
		PLUGIN_SUPPORT_URL);

	return result;
}

PF_Err
EffectMain(
	PF_Cmd			cmd,
	PF_InData		*in_data,
	PF_OutData		*out_data,
	PF_ParamDef		*params[],
	PF_LayerDef		*output,
	void			*extra)
{
	PF_Err err = PF_Err_NONE;

	// After Effects is C. An exception that leaves this function crashes the
	// host (and calls terminate() outright on Apple Silicon).
	try {
		switch (cmd) {
			case PF_Cmd_ABOUT:
				err = About(in_data, out_data);
				break;
			case PF_Cmd_GLOBAL_SETUP:
				err = GlobalSetup(in_data, out_data);
				break;
			case PF_Cmd_PARAMS_SETUP:
				err = ParamsSetup(in_data, out_data);
				break;
			case PF_Cmd_SMART_PRE_RENDER:
				err = PreRender(in_data, out_data, static_cast<PF_PreRenderExtra*>(extra));
				break;
			case PF_Cmd_SMART_RENDER:
				err = SmartRender(in_data, out_data, static_cast<PF_SmartRenderExtra*>(extra));
				break;
			default:
				break;
		}
	}
	catch (PF_Err &thrown) {
		err = thrown;
	}
	catch (const std::bad_alloc &) {
		err = PF_Err_OUT_OF_MEMORY;
	}
	catch (...) {
		err = PF_Err_INTERNAL_STRUCT_DAMAGED;
	}
	return err;
}

"""
Stand-in SAM 2 models for the tests (addendum 04).

    python scripts/make-sam2-test-models.py src/main/__tests__/fixtures/sam2-standin

Two tiny ONNX graphs with exactly the tensor names, types and shapes of a
samexporter SAM 2.1 export (see src/shared/roto/sam2.ts), and trivial maths:
the "encoder" average-pools the normalised image into the three feature maps;
the "decoder" marks as foreground what is redder than ~160/255 (channel 0 of
high_res_feats_0) and predicts IoUs 0.3 / 0.9 / 0.5. They prove the loading,
feeding and reading of onnxruntime-node — not segmentation quality. They are
NOT SAM 2 and contain no Meta weights.
"""
import sys
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

out = sys.argv[1] if len(sys.argv) > 1 else '.'
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def select(channels):
    """1×1 conv weights copying input channel (c % 3) to output channel c."""
    w = np.zeros((channels, 3, 1, 1), dtype=np.float32)
    for c in range(channels):
        w[c, c % 3, 0, 0] = 1.0
    return w


nodes = []
inits = []
for name, k, ch in [('high_res_feats_0', 4, 32), ('high_res_feats_1', 8, 64), ('image_embed', 16, 256)]:
    nodes.append(helper.make_node('AveragePool', ['image'], [f'{name}_pool'], kernel_shape=[k, k], strides=[k, k]))
    inits.append(numpy_helper.from_array(select(ch), f'{name}_w'))
    nodes.append(helper.make_node('Conv', [f'{name}_pool', f'{name}_w'], [name]))
encoder = helper.make_graph(
    nodes,
    'sam2_standin_encoder',
    [helper.make_tensor_value_info('image', TensorProto.FLOAT, [1, 3, 1024, 1024])],
    [
        helper.make_tensor_value_info('high_res_feats_0', TensorProto.FLOAT, [1, 32, 256, 256]),
        helper.make_tensor_value_info('high_res_feats_1', TensorProto.FLOAT, [1, 64, 128, 128]),
        helper.make_tensor_value_info('image_embed', TensorProto.FLOAT, [1, 256, 64, 64]),
    ],
    inits,
)

threshold = (160 / 255 - MEAN[0]) / STD[0]
d_nodes = [
    helper.make_node('Slice', ['high_res_feats_0', 'starts', 'ends', 'axes'], ['red']),
    helper.make_node('Sub', ['red', 'threshold'], ['centred']),
    helper.make_node('Mul', ['centred', 'gain'], ['logit']),
    # Every prompt input takes part (times zero), so the graph needs them all.
    helper.make_node('ReduceSum', ['point_coords'], ['pc_sum'], keepdims=0),
    helper.make_node('ReduceSum', ['point_labels'], ['pl_sum'], keepdims=0),
    helper.make_node('ReduceSum', ['mask_input'], ['mi_sum'], keepdims=0),
    helper.make_node('ReduceSum', ['has_mask_input'], ['hm_sum'], keepdims=0),
    helper.make_node('ReduceSum', ['image_embed'], ['ie_sum'], keepdims=0),
    helper.make_node('ReduceSum', ['high_res_feats_1'], ['h1_sum'], keepdims=0),
    helper.make_node('Sum', ['pc_sum', 'pl_sum', 'mi_sum', 'hm_sum', 'ie_sum', 'h1_sum'], ['all_sum']),
    helper.make_node('Mul', ['all_sum', 'zero'], ['nothing']),
    helper.make_node('Add', ['logit', 'nothing'], ['logit0']),
    helper.make_node('Neg', ['logit0'], ['inverse']),
    helper.make_node('Concat', ['inverse', 'logit0', 'inverse'], ['masks'], axis=1),
    helper.make_node('Add', ['ious', 'nothing'], ['iou_predictions']),
]
d_inits = [
    numpy_helper.from_array(np.array([0], dtype=np.int64), 'starts'),
    numpy_helper.from_array(np.array([1], dtype=np.int64), 'ends'),
    numpy_helper.from_array(np.array([1], dtype=np.int64), 'axes'),
    numpy_helper.from_array(np.array(threshold, dtype=np.float32), 'threshold'),
    numpy_helper.from_array(np.array(20.0, dtype=np.float32), 'gain'),
    numpy_helper.from_array(np.array(0.0, dtype=np.float32), 'zero'),
    numpy_helper.from_array(np.array([[0.3, 0.9, 0.5]], dtype=np.float32), 'ious'),
]
decoder = helper.make_graph(
    d_nodes,
    'sam2_standin_decoder',
    [
        helper.make_tensor_value_info('image_embed', TensorProto.FLOAT, [1, 256, 64, 64]),
        helper.make_tensor_value_info('high_res_feats_0', TensorProto.FLOAT, [1, 32, 256, 256]),
        helper.make_tensor_value_info('high_res_feats_1', TensorProto.FLOAT, [1, 64, 128, 128]),
        helper.make_tensor_value_info('point_coords', TensorProto.FLOAT, ['num_labels', 'num_points', 2]),
        helper.make_tensor_value_info('point_labels', TensorProto.FLOAT, ['num_labels', 'num_points']),
        helper.make_tensor_value_info('mask_input', TensorProto.FLOAT, ['num_labels', 1, 256, 256]),
        helper.make_tensor_value_info('has_mask_input', TensorProto.FLOAT, ['num_labels']),
    ],
    [
        helper.make_tensor_value_info('masks', TensorProto.FLOAT, [1, 3, 256, 256]),
        helper.make_tensor_value_info('iou_predictions', TensorProto.FLOAT, [1, 3]),
    ],
    d_inits,
)

for graph, name in [(encoder, 'encoder'), (decoder, 'decoder')]:
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='vcvfx-sam2-standin')
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, f'{out}/standin.{name}.onnx')
    print(f'{out}/standin.{name}.onnx')
